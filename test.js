const axios = require('axios');
const fs = require('fs');

async function test() {
    try {
        console.log('Iniciando prueba de generación de PDF...');
        const response = await axios.post('http://localhost:3000/api/quote/generate', {
            cliente_nombre: "Daikin Airconditioning Mexico",
            atencion: "Brithanie",
            items: [
                { clave: "DSC120-SCG", cantidad: 2 },
                { clave: "MQIU-173036-RC", cantidad: 1 }
            ]
        }, {
            responseType: 'arraybuffer'
        });

        fs.writeFileSync('test_quote.pdf', response.data);
        console.log('✅ PDF generado con éxito: test_quote.pdf');
    } catch (error) {
        console.error('❌ Error en la prueba:', error.response ? error.response.data.toString() : error.message);
    }
}

test();
