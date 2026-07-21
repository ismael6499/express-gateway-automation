const fs = require('fs');
const path = require('path');

const src = path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data', 'Profile 4');
const dest = path.join(__dirname, 'browser_user_data', 'Default');

console.log(`Copiando perfil de:\n  ${src}\nhacia:\n  ${dest}\n`);

// Crear directorios si no existen
if (!fs.existsSync(src)) {
  console.log('Error: La carpeta de origen no existe.');
  process.exit(1);
}

function copyRecursive(srcDir, destDir) {
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  const items = fs.readdirSync(srcDir);
  for (let item of items) {
    // Ignorar cache y archivos temporales gigantescos para que sea rápido
    if (['cache', 'code cache', 'lock', 'lockfile', 'gpuCache', 'session storage', 'snapshots'].includes(item.toLowerCase())) {
      continue;
    }

    const srcPath = path.join(srcDir, item);
    const destPath = path.join(destDir, item);

    try {
      const stats = fs.statSync(srcPath);
      if (stats.isDirectory()) {
        copyRecursive(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    } catch (err) {
      // Ignorar archivos bloqueados
      console.log(`Saltando (bloqueado/error): ${item}`);
    }
  }
}

// Limpiar destino previo
if (fs.existsSync(dest)) {
  try {
    fs.rmSync(dest, { recursive: true, force: true });
    console.log('Carpeta destino limpia.');
  } catch (e) {
    console.log('Aviso al limpiar destino:', e.message);
  }
}

try {
  copyRecursive(src, dest);
  console.log('\n¡Copia de perfil completada con éxito!');
} catch (e) {
  console.error('Error durante la copia:', e);
}
