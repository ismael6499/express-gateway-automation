const fs = require('fs');
const path = require('path');

const prefPath = path.join(__dirname, 'browser_user_data', 'Default', 'Preferences');
console.log('Inspeccionando Preferences en:', prefPath);

if (!fs.existsSync(prefPath)) {
  console.log('No existe el archivo de Preferencias en browser_user_data.');
  process.exit(0);
}

try {
  const content = fs.readFileSync(prefPath, 'utf8');
  const data = JSON.parse(content);
  
  // Buscar configuraciones de limpieza al salir
  console.log('\n--- Configuraciones encontradas ---');
  if (data.profile) {
    console.log('profile.ephemeral_mode:', data.profile.ephemeral_mode);
  }
  
  // Buscar claves que contengan "clear" o "exit" o "close" en todo el objeto
  const matches = [];
  function searchKeys(obj, prefix = '') {
    if (!obj || typeof obj !== 'object') return;
    for (let key in obj) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (key.toLowerCase().includes('clear') || key.toLowerCase().includes('exit') || key.toLowerCase().includes('ephemeral') || key.toLowerCase().includes('close')) {
        matches.push(`${fullKey}: ${JSON.stringify(obj[key])}`);
      }
      if (typeof obj[key] === 'object') {
        searchKeys(obj[key], fullKey);
      }
    }
  }
  searchKeys(data);
  console.log(matches.join('\n'));
} catch (e) {
  console.error('Error:', e.message);
}
