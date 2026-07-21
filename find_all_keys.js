const fs = require('fs');
const path = require('path');

const prefPath = path.join(__dirname, 'browser_user_data', 'Default', 'Preferences');
if (!fs.existsSync(prefPath)) {
  console.log('No existe.');
  process.exit(0);
}

const data = JSON.parse(fs.readFileSync(prefPath, 'utf8'));

const matches = [];
function search(obj, pathStr = '') {
  if (!obj || typeof obj !== 'object') return;
  for (let key in obj) {
    const currentPath = pathStr ? `${pathStr}.${key}` : key;
    if (
      key.toLowerCase().includes('clear') ||
      key.toLowerCase().includes('delete') ||
      key.toLowerCase().includes('destroy') ||
      key.toLowerCase().includes('exit') ||
      key.toLowerCase().includes('session') ||
      key.toLowerCase().includes('persist') ||
      key.toLowerCase().includes('keep')
    ) {
      matches.push(`${currentPath}: ${JSON.stringify(obj[key])}`);
    }
    search(obj[key], currentPath);
  }
}

search(data);
console.log(matches.join('\n'));
