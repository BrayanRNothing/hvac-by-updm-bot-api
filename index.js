// Polyfill Web Streams API para Node.js < 18 (requerido por Puppeteer)
if (typeof ReadableStream === 'undefined') {
    const webStreams = require('stream/web');
    global.ReadableStream = webStreams.ReadableStream;
    global.WritableStream = webStreams.WritableStream;
    global.TransformStream = webStreams.TransformStream;
}

const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// Servir la carpeta de cotizaciones para que sean accesibles públicamente por URL
app.use('/quotes', express.static(path.join(__dirname, 'quotes')));

let catalog = require('./catalog.json');
const axios = require('axios');

async function syncCatalog() {
    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
        console.log("[Caché] No se definió GOOGLE_SHEET_ID en .env. Se usará el catálogo local.");
        return;
    }
    try {
        // Consultamos la pestaña 'catalogo' en formato CSV
        const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=catalogo`;
        const response = await axios.get(url);
        const csvData = response.data;
        
        const lines = csvData.split('\n');
        if (lines.length <= 1) return;
        
        const newCatalog = {
            config: {
                tipo_cambio_base: 20.0,
                iva: 0.16,
                moneda_default: "USD",
                vigencia_dias: 15
            },
            servicios: {
                recubrimiento: {},
                mantenimiento: {},
                viaticos: {}
            }
        };

        // Función simple para parsear CSV respetando comillas
        const parseCSVLine = (line) => {
            const result = [];
            let current = '';
            let inQuotes = false;
            for (let i = 0; i < line.length; i++) {
                const char = line[i];
                if (char === '"') {
                    inQuotes = !inQuotes;
                } else if (char === ',' && !inQuotes) {
                    result.push(current.trim());
                    current = '';
                } else {
                    current += char;
                }
            }
            result.push(current.trim());
            return result;
        };

        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const columns = parseCSVLine(line);
            if (columns.length < 5) continue;

            const [clave, modelo, precioStr, descripcion, categoria] = columns;
            if (!clave) continue;

            // Limpiar comillas y formatear precio
            const cleanClave = clave.replace(/^"|"$/g, '').trim().toUpperCase();
            const cleanModelo = modelo.replace(/^"|"$/g, '').trim();
            const cleanPrecio = parseFloat(precioStr.replace(/[^0-9.]/g, '')) || 0;
            const cleanDescripcion = descripcion.replace(/^"|"$/g, '').trim();
            const cleanCategoria = categoria.replace(/^"|"$/g, '').toLowerCase().trim();

            const item = {
                descripcion: cleanDescripcion || cleanModelo,
                precio_usd: cleanPrecio
            };

            if (cleanCategoria.includes('recubrimiento')) {
                newCatalog.servicios.recubrimiento[cleanClave] = item;
            } else if (cleanCategoria.includes('mantenimiento')) {
                newCatalog.servicios.mantenimiento[cleanClave] = item;
            } else if (cleanCategoria.includes('viatico') || cleanCategoria.includes('viáticos')) {
                newCatalog.servicios.viaticos[cleanClave] = item;
            }
        }

        const totalItems = Object.keys(newCatalog.servicios.recubrimiento).length + 
                           Object.keys(newCatalog.servicios.mantenimiento).length + 
                           Object.keys(newCatalog.servicios.viaticos).length;
        
        if (totalItems > 0) {
            catalog = newCatalog;
            fs.writeFileSync(path.join(__dirname, 'catalog.json'), JSON.stringify(catalog, null, 2));
            console.log(`[Caché] Catálogo sincronizado exitosamente desde Google Sheets. ${totalItems} productos cargados.`);
        } else {
            console.log("[Caché] Sincronización ignorada: El CSV descargado no contenía productos válidos.");
        }
    } catch (error) {
        console.error("[Caché] Error sincronizando catálogo desde Google Sheets:", error.message);
    }
}

// Rutas auxiliares para ver y sincronizar el catálogo manual
app.get('/api/catalog', (req, res) => {
    res.json(catalog);
});

app.post('/api/catalog/sync', async (req, res) => {
    await syncCatalog();
    res.json({ 
        success: true, 
        message: "Catálogo sincronizado exitosamente", 
        total_items: Object.keys(catalog.servicios.recubrimiento).length + 
                     Object.keys(catalog.servicios.mantenimiento).length + 
                     Object.keys(catalog.servicios.viaticos).length 
    });
});

// Obtener la URL del último PDF cotizado para un número de teléfono específico
app.get('/api/quote/latest', (req, res) => {
    const { telefono } = req.query;
    if (!telefono) {
        return res.status(400).json({ error: "Se requiere el parámetro 'telefono'" });
    }
    const cleanPhone = telefono.replace(/[^0-9]/g, '');
    const latestQuotesPath = path.join(__dirname, 'latest_quotes.json');
    let pdfUrl = null;
    try {
        if (fs.existsSync(latestQuotesPath)) {
            const latestQuotes = JSON.parse(fs.readFileSync(latestQuotesPath, 'utf8'));
            pdfUrl = latestQuotes[cleanPhone] || null;
        }
    } catch (e) {
        console.error("Error al buscar cotización reciente:", e.message);
    }
    res.json({ pdfUrl });
});


// Función para formatear números como moneda
const formatCurrency = (num) => num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

app.post('/api/quote/generate', async (req, res) => {
    try {
        const { 
            cliente_nombre, 
            atencion, 
            items, // Array de { clave, cantidad }
            tc = catalog.config.tipo_cambio_base,
            telefono
        } = req.body;

        if (!items || !items.length) {
            return res.status(400).json({ error: 'Se requieren items para cotizar' });
        }

        // --- NORMALIZAR ITEMS ---
        // Acepta cualquier nombre de campo que n8n pueda mandar para cantidad y clave
        const normalizeItems = (rawItems) => {
            const rawArray = Array.isArray(rawItems) ? rawItems : [rawItems];

            // Normalizar cada item: extraer clave y cantidad sin importar el nombre del campo
            const normalized = rawArray.map(item => {
                const clave = (item.clave || item.modelo || item.code || item.sku || '').toString().trim().toUpperCase();
                const cantidad = parseInt(
                    item.cantidad ?? item.quantity ?? item.qty ?? item.units ?? item.amount ?? item.cantidades ?? 1,
                    10
                ) || 1;
                return { clave, cantidad };
            }).filter(i => i.clave !== '');

            // Consolidar items duplicados (sumar cantidades)
            const consolidated = {};
            normalized.forEach(item => {
                if (consolidated[item.clave]) {
                    consolidated[item.clave].cantidad += item.cantidad;
                } else {
                    consolidated[item.clave] = { ...item };
                }
            });

            return Object.values(consolidated);
        };

        const normalizedItems = normalizeItems(items);

        // 1. Calcular Datos de la Cotización
        let subtotal = 0;
        const processedItems = normalizedItems.map(item => {
            let key = item.clave;
            let catalogItem = catalog.servicios.recubrimiento[key] || catalog.servicios.mantenimiento[key] || catalog.servicios.viaticos?.[key];

            // Si no hay match exacto, buscar coincidencia parcial
            if (!catalogItem) {
                const allKeys = [
                    ...Object.keys(catalog.servicios.recubrimiento),
                    ...Object.keys(catalog.servicios.mantenimiento),
                    ...Object.keys(catalog.servicios.viaticos || {})
                ];
                const foundKey = allKeys.find(k => k.includes(key) || key.includes(k));
                if (foundKey) {
                    key = foundKey;
                    catalogItem = catalog.servicios.recubrimiento[key] || catalog.servicios.mantenimiento[key] || catalog.servicios.viaticos?.[key];
                }
            }

            if (!catalogItem) {
                throw new Error(`Clave no encontrada en el catálogo: "${item.clave}". Verifica que la clave sea correcta.`);
            }

            const cantidad = item.cantidad;
            const precioUsd = catalogItem.precio_usd;
            const importe = precioUsd * cantidad;
            subtotal += importe;

            return {
                cantidad,
                clave: key,
                descripcion: catalogItem.descripcion,
                precio_unitario: formatCurrency(precioUsd),
                importe: formatCurrency(importe),
                moneda: catalog.config.moneda_default
            };
        });

        const iva = subtotal * catalog.config.iva;
        const total = subtotal + iva;

        // Obtener o incrementar folio secuencial de manera persistente (empieza en 1001)
        let folioNumero = 1001;
        const folioFilePath = path.join(__dirname, 'folio.txt');
        try {
            if (fs.existsSync(folioFilePath)) {
                const contenido = fs.readFileSync(folioFilePath, 'utf8').trim();
                const parsed = parseInt(contenido, 10);
                if (!isNaN(parsed)) {
                    folioNumero = parsed + 1;
                }
            }
            fs.writeFileSync(folioFilePath, folioNumero.toString(), 'utf8');
        } catch (e) {
            console.error("Error al gestionar folio secuencial:", e.message);
            folioNumero = Math.floor(Math.random() * 9000) + 1000;
        }
        const folio = `BOT-${folioNumero}`;

        const fecha = new Date().toLocaleDateString('es-MX', { year: 'numeric', month: 'long', day: 'numeric' });

        // Formatear información del cliente evitando duplicar nombre si son iguales
        let clienteInfoHtml = `<p style="margin: 3px 0;"><strong>Cotizado a:</strong> ${cliente_nombre.toUpperCase()}</p>`;
        if (atencion && atencion.trim() !== '' && atencion.toLowerCase() !== cliente_nombre.toLowerCase()) {
            clienteInfoHtml += `<p style="margin: 3px 0;"><strong>Atención:</strong> ${atencion.toUpperCase()}</p>`;
        }

        // 2. Preparar el HTML
        let htmlTemplate = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');
        
        // Reemplazos básicos
        htmlTemplate = htmlTemplate
            .replace('{{folio}}', folio)
            .replace('{{fecha}}', fecha.toUpperCase())
            .replace('{{tc}}', tc.toFixed(4))
            .replace('{{cliente_info}}', clienteInfoHtml)
            .replace(/{{moneda}}/g, catalog.config.moneda_default)
            .replace('{{subtotal}}', formatCurrency(subtotal))
            .replace('{{iva}}', formatCurrency(iva))
            .replace('{{total}}', formatCurrency(total))
            .replace('{{vigencia}}', catalog.config.vigencia_dias);

        // Reemplazo de items (Básico para el ejemplo sin motor de plantillas complejo)
        const itemsHtml = processedItems.map(item => `
            <tr>
                <td>${item.cantidad}.00</td>
                <td>${item.clave}</td>
                <td>${item.descripcion}</td>
                <td style="text-align: right;">${item.precio_unitario} ${catalog.config.moneda_default}</td>
                <td style="text-align: right;">${item.importe} ${catalog.config.moneda_default}</td>
            </tr>
        `).join('');

        // Usaremos un método más robusto para los items
        const tableSplit = htmlTemplate.split('<tbody>');
        const bottomSplit = tableSplit[1].split('</tbody>');
        // Asegurar que se cierra el </tbody> para no romper el HTML y que se vean los totales
        htmlTemplate = tableSplit[0] + '<tbody>' + itemsHtml + '</tbody>' + bottomSplit[1];

        // 3. Generar PDF con Puppeteer (Importado dinámicamente para compatibilidad ESM)
        const puppeteerModule = await import('puppeteer');
        const puppeteer = puppeteerModule.default || puppeteerModule;

        // En Railway, Chromium puede estar instalado en /usr/bin/chromium o /usr/bin/chromium-browser
        const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH ||
            (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);

        const browser = await puppeteer.launch({
            executablePath,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        });
        const page = await browser.newPage();
        await page.setContent(htmlTemplate, { waitUntil: 'networkidle0' });
        const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
        await browser.close();

        // 4. Guardar PDF localmente para que sea accesible públicamente por URL
        const quotesDir = path.join(__dirname, 'quotes');
        if (!fs.existsSync(quotesDir)) {
            fs.mkdirSync(quotesDir, { recursive: true });
        }
        const fileName = `Cotizacion_${folio}.pdf`;
        const pdfPath = path.join(quotesDir, fileName);
        fs.writeFileSync(pdfPath, pdfBuffer);

        // Construir la URL pública dinámica del PDF
        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = req.get('host');
        const pdfUrl = `${protocol}://${host}/quotes/${fileName}`;

        // Registrar esta cotización para el teléfono en latest_quotes.json si viene especificado
        if (telefono) {
            const latestQuotesPath = path.join(__dirname, 'latest_quotes.json');
            let latestQuotes = {};
            try {
                if (fs.existsSync(latestQuotesPath)) {
                    latestQuotes = JSON.parse(fs.readFileSync(latestQuotesPath, 'utf8'));
                }
            } catch (e) {
                console.error("Error al leer latest_quotes.json:", e.message);
            }
            const cleanPhone = telefono.replace(/[^0-9]/g, '');
            latestQuotes[cleanPhone] = pdfUrl;
            try {
                fs.writeFileSync(latestQuotesPath, JSON.stringify(latestQuotes, null, 2), 'utf8');
            } catch (e) {
                console.error("Error al escribir latest_quotes.json:", e.message);
            }
        }

        // 5. Enviar PDF en base64 para n8n y Evolution API con su URL pública
        const base64Pdf = Buffer.from(pdfBuffer).toString('base64');
        res.setHeader('Content-Type', 'application/json');
        res.send(JSON.stringify({
            success: true,
            fileName: fileName,
            mimetype: 'application/pdf',
            document_b64: base64Pdf,
            pdfUrl: pdfUrl
        }));

    } catch (error) {
        console.error('Error generando PDF:', error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor de cotizaciones corriendo en puerto ${PORT}`);
    
    // Iniciar sincronización automática
    syncCatalog();
    
    // Configurar intervalo para sincronizar cada 5 minutos
    setInterval(syncCatalog, 5 * 60 * 1000);
});
