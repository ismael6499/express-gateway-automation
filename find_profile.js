const fs = require('fs');
const path = require('path');

const localAppData = process.env.LOCALAPPDATA;
console.log('Escaneando de forma recursiva C:\\Users\\agust\\AppData\\Local\\ buscando perfiles...');

function searchPreferences(dir) {
  try {
    const items = fs.readdirSync(dir);
    for (let item of items) {
      const fullPath = path.join(dir, item);
      let stats;
      try {
        stats = fs.statSync(fullPath);
      } catch (e) {
        continue; // Ignorar archivos especiales
      }

      if (stats.isDirectory()) {
        // Optimización: solo entrar en carpetas de navegadores comunes
        const lower = item.toLowerCase();
        if (dir === localAppData && !['google', 'microsoft', 'brave', 'chromium', 'opera', 'vivaldi'].includes(lower)) {
          continue;
        }
        searchPreferences(fullPath);
      } else if (item === 'Preferences') {
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          const data = JSON.parse(content);
          const name = data.profile?.name || data.profile?.info_cache?.name || '';
          const email = data.profile?.email || data.google?.services?.username || '';
          const containsWork = content.toLowerCase().includes('workspace') || content.toLowerCase().includes('user');
          
          console.log(`\nArchivo: ${fullPath}`);
          console.log(` - Nombre Perfil: "${name}"`);
          console.log(` - Email/Usuario: "${email}"`);
          console.log(` - Contiene workspace: ${containsWork ? 'SÍ' : 'NO'}`);
        } catch (e) {}
      }
    }
  } catch (e) {}
}

searchPreferences(localAppData);
console.log('\nEscaneo completado.');
