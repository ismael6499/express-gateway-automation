/**
 * tools/render_ui_tree.js
 * 
 * In-memory Virtual DOM / React-style JSON UI Tree Compiler and Localization Auditor.
 * Parses HTML templates from server.js into structured AST / Virtual DOM nodes:
 * { component, id, props, text, stringKey, children }
 * 
 * Usage:
 *   node tools/render_ui_tree.js --screens
 *   node tools/render_ui_tree.js <en|es> <screen_id>
 *   node tools/render_ui_tree.js --audit
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const LOCALES_DIR = path.join(ROOT_DIR, 'locales');
const SERVER_JS_PATH = path.join(ROOT_DIR, 'server.js');

// 1. Load Dictionaries
function loadLocales() {
  const en = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, 'en.json'), 'utf8'));
  const es = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, 'es.json'), 'utf8'));
  return { en, es };
}

// 2. Extract Templates from server.js
function extractTemplates() {
  const serverContent = fs.readFileSync(SERVER_JS_PATH, 'utf8');

  function extractTemplateLiteral(varName) {
    const regex = new RegExp(`const\\s+${varName}\\s*=\\s*\`([\\s\\S]*?)\`;`, 'm');
    const match = serverContent.match(regex);
    if (!match) {
      throw new Error(`Could not find ${varName} in ${SERVER_JS_PATH}`);
    }
    return match[1];
  }

  const loginHtml = extractTemplateLiteral('LOGIN_HTML');
  const dashboardHtml = extractTemplateLiteral('DASHBOARD_HTML');

  return { loginHtml, dashboardHtml, serverContent };
}

// Void HTML elements that cannot have children
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
  // SVG void/leaf tags
  'path', 'circle', 'line', 'polyline', 'polygon', 'rect'
]);

// 3. Lightweight HTML Parser & VDOM Compiler
function parseHtmlToVdom(htmlStr, targetIdOrClass = null) {
  // Strip comments, style and script contents
  let cleanHtml = htmlStr
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '');

  if (targetIdOrClass) {
    cleanHtml = extractSubTree(cleanHtml, targetIdOrClass);
    if (!cleanHtml) {
      throw new Error(`Screen or component not found: ${targetIdOrClass}`);
    }
  }

  // Tokenize tags and text
  const tokens = [];
  const tagRegex = /<(\/)?([a-zA-Z0-9-]+)((?:\s+[^>]+?)?)(\/)?>|([^<]+)/g;
  let match;

  while ((match = tagRegex.exec(cleanHtml)) !== null) {
    if (match[5]) {
      // Text node
      const rawText = match[5].trim();
      if (rawText) {
        tokens.push({ type: 'text', content: rawText });
      }
    } else {
      const isClose = !!match[1];
      const tagName = match[2].toLowerCase();
      const rawAttrs = match[3] || '';
      const isSelfClosing = !!match[4] || VOID_ELEMENTS.has(tagName);

      if (isClose) {
        tokens.push({ type: 'tag_close', tagName });
      } else {
        const attrs = parseAttributes(rawAttrs);
        tokens.push({
          type: 'tag_open',
          tagName,
          attrs,
          isSelfClosing
        });
      }
    }
  }

  // Build Tree
  const root = { component: 'root', children: [] };
  const stack = [root];

  for (const token of tokens) {
    const currentParent = stack[stack.length - 1];

    if (token.type === 'text') {
      if (currentParent.children.length > 0) {
        const lastChild = currentParent.children[currentParent.children.length - 1];
        if (lastChild.component === '#text') {
          lastChild.text += ' ' + token.content;
          continue;
        }
      }
      currentParent.children.push({
        component: '#text',
        text: token.content
      });
    } else if (token.type === 'tag_open') {
      const node = {
        component: token.tagName,
        props: token.attrs
      };

      if (token.attrs.id) {
        node.id = token.attrs.id;
        delete node.props.id;
      }
      if (token.attrs['data-i18n']) {
        node.stringKey = token.attrs['data-i18n'];
        delete node.props['data-i18n'];
      }

      node.children = [];

      currentParent.children.push(node);

      if (!token.isSelfClosing) {
        stack.push(node);
      }
    } else if (token.type === 'tag_close') {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].component === token.tagName) {
          stack.splice(i);
          break;
        }
      }
    }
  }

  // Simplify root
  const nodes = root.children;
  if (nodes.length === 1) {
    return cleanNode(nodes[0]);
  }
  return {
    component: 'Fragment',
    children: nodes.map(cleanNode)
  };
}

function parseAttributes(rawAttrs) {
  const attrs = {};
  if (!rawAttrs) return attrs;

  const attrRegex = /([a-zA-Z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match;
  while ((match = attrRegex.exec(rawAttrs)) !== null) {
    const key = match[1];
    let val = match[2] !== undefined ? match[2] :
              match[3] !== undefined ? match[3] :
              match[4] !== undefined ? match[4] : true;
    if (key === 'class') {
      attrs.className = val;
    } else {
      attrs[key] = val;
    }
  }
  return attrs;
}

function cleanNode(node) {
  // If node only has 1 text child and no other children, hoist text
  if (node.children && node.children.length === 1 && node.children[0].component === '#text') {
    node.text = node.children[0].text;
    node.children = [];
  } else if (node.children && node.children.length > 0) {
    node.children = node.children.map(cleanNode);
  }

  if (node.children && node.children.length === 0) {
    delete node.children;
  }
  if (node.props && Object.keys(node.props).length === 0) {
    delete node.props;
  }
  return node;
}

function extractSubTree(html, targetIdOrClass) {
  // First test if targetIdOrClass matches a direct tag name like <main> or <header>
  const tagOnlyRegex = new RegExp(`<(${targetIdOrClass})\\b[^>]*>`, 'i');
  let match = tagOnlyRegex.exec(html);
  let tagName = targetIdOrClass.toLowerCase();

  if (!match) {
    // Search for element with id="target" or class="target"
    const tagStartRegex = new RegExp(`<([a-zA-Z0-9-]+)[^>]*(?:id=["']${targetIdOrClass}["']|class=["'][^"']*\\b${targetIdOrClass}\\b[^"']*)[^>]*>`, 'i');
    match = tagStartRegex.exec(html);
    if (!match) return null;
    tagName = match[1].toLowerCase();
  }

  const startIndex = match.index;

  // Find matching closing tag with depth counter
  let depth = 0;
  const tagSearchRegex = new RegExp(`<(\\/)?${tagName}(?:\\s+[^>]*)?>`, 'gi');
  tagSearchRegex.lastIndex = startIndex;

  let tagMatch;
  while ((tagMatch = tagSearchRegex.exec(html)) !== null) {
    if (tagMatch[1]) {
      depth--;
      if (depth === 0) {
        return html.substring(startIndex, tagSearchRegex.lastIndex);
      }
    } else {
      depth++;
    }
  }

  return html.substring(startIndex);
}

// 4. Apply Localization to Virtual DOM Tree
function applyLocalization(vdom, dict) {
  if (!vdom) return null;

  const clone = JSON.parse(JSON.stringify(vdom));

  function traverse(node) {
    if (!node) return;

    if (node.stringKey && dict[node.stringKey]) {
      node.text = dict[node.stringKey];
    }

    if (node.props) {
      if (node.props['data-i18n-placeholder'] && dict[node.props['data-i18n-placeholder']]) {
        node.props.placeholder = dict[node.props['data-i18n-placeholder']];
      }
      if (node.props['data-i18n-title'] && dict[node.props['data-i18n-title']]) {
        node.props.title = dict[node.props['data-i18n-title']];
      }
      if (node.props['data-i18n-sub-title'] && dict[node.props['data-i18n-sub-title']]) {
        node.props['data-sub-title'] = dict[node.props['data-i18n-sub-title']];
      }
    }

    if (node.children && Array.isArray(node.children)) {
      node.children.forEach(traverse);
    }
  }

  traverse(clone);
  return clone;
}

// 5. Screen & Component Registry
const SCREENS = {
  login: { source: 'loginHtml', selector: 'login-container' },
  dashboard: { source: 'dashboardHtml', selector: 'main' },
  header: { source: 'dashboardHtml', selector: 'header' },
  editModeBanner: { source: 'dashboardHtml', selector: 'editModeBanner' },
  cardBrowser: { source: 'dashboardHtml', selector: 'cardBrowser' },
  cardMousePad: { source: 'dashboardHtml', selector: 'cardMousePad' },
  cardTeclado: { source: 'dashboardHtml', selector: 'cardTeclado' },
  cardSistema: { source: 'dashboardHtml', selector: 'cardSistema' },
  cardMultimedia: { source: 'dashboardHtml', selector: 'cardMultimedia' },
  cardEnergia: { source: 'dashboardHtml', selector: 'cardEnergia' },
  cardReiniciar: { source: 'dashboardHtml', selector: 'cardReiniciar' },
  modalPausaTemporal: { source: 'dashboardHtml', selector: 'modalPausaTemporal' },
  restartOverlay: { source: 'dashboardHtml', selector: 'restartOverlay' }
};

// 6. Spanish Audit Patterns & Words
const SPANISH_WORD_PATTERNS = [
  /\b(abrir|cerrar|iniciar|pausa|pausar|pantalla|teclado|raton|ratón|guardian|guardián|activo|inactivo|reiniciar|modo|edición|edicion|herramientas|arrastrar|oculto|ocultar|portapapeles|captura|capturar|brillo|sonido|volumen|energia|energía|sesion|sesión|bloquear|suspender|hablar|enviar|combinacion|combinación|teclas|servidor|exito|éxito|fallo|clave|ingresar|acceso|requerido|desactivar|encender|apagar|sensibilidad|velocidad|arriba|abajo|derecho|izquierdo|doble|soltar|minutos|segundos|hora|horas|dias|días|semana|ultima|última|hace|silenciado|reproduciendo|pausado|mutear|salto|linea|línea|borrar|sugerencias|especiales|funcion|función|personalizadas|completa|rueda|bloque|sección|seccion|ventana|programación|programacion|acciones|pulsaciones|duración|duracion|guardar|cancelar|confirmar|minutos)\b/i,
  /[áéíóúüñ¿¡]/i
];

function isSpanishText(text) {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length < 2) return false;
  // Ignore purely technical or symbol text
  if (/^[^a-zA-ZáéíóúÁÉÍÓÚñÑ]+$/.test(trimmed)) return false;
  return SPANISH_WORD_PATTERNS.some(regex => regex.test(trimmed));
}

// 7. Audit Mode Runner
function runAudit() {
  console.log('====================================================');
  console.log('🔍 Virtual DOM UI Tree & i18n Localization Auditor');
  console.log('====================================================\n');

  const { en, es } = loadLocales();
  const templates = extractTemplates();

  let totalIssues = 0;
  const issues = [];

  // Check dictionary symmetry
  const enKeys = new Set(Object.keys(en));
  const esKeys = new Set(Object.keys(es));

  for (const k of enKeys) {
    if (!esKeys.has(k)) {
      issues.push({ screen: 'dictionaries', id: k, text: en[k], reason: `Key '${k}' exists in en.json but is missing in es.json` });
      totalIssues++;
    }
  }
  for (const k of esKeys) {
    if (!enKeys.has(k)) {
      issues.push({ screen: 'dictionaries', id: k, text: es[k], reason: `Key '${k}' exists in es.json but is missing in en.json` });
      totalIssues++;
    }
  }

  // Audit each screen in English mode
  for (const [screenId, screenDef] of Object.entries(SCREENS)) {
    const rawHtml = templates[screenDef.source];
    try {
      const vdom = parseHtmlToVdom(rawHtml, screenDef.selector);
      const localizedVdom = applyLocalization(vdom, en);

      function auditNode(node, pathStr) {
        if (!node) return;

        const currentPath = `${pathStr} > ${node.component}${node.id ? '#' + node.id : ''}`;

        // Check node text
        if (node.text && isSpanishText(node.text)) {
          // If it has a stringKey but text is still Spanish, check dictionary
          const isFromDict = node.stringKey && en[node.stringKey] === node.text;
          issues.push({
            screen: screenId,
            id: node.id || node.component,
            path: currentPath,
            stringKey: node.stringKey || null,
            text: node.text,
            reason: isFromDict ? `String key '${node.stringKey}' in en.json contains Spanish text` : `Leftover Spanish static text (missing or untranslated data-i18n)`
          });
          totalIssues++;
        }

        // Check props
        if (node.props) {
          ['placeholder', 'title', 'alt', 'data-sub-title'].forEach(propName => {
            const propVal = node.props[propName];
            if (propVal && typeof propVal === 'string' && isSpanishText(propVal)) {
              issues.push({
                screen: screenId,
                id: node.id || node.component,
                path: `${currentPath}[${propName}]`,
                stringKey: node.props[`data-i18n-${propName}`] || null,
                text: propVal,
                reason: `Property '${propName}' contains Spanish text without English i18n binding`
              });
              totalIssues++;
            }
          });
        }

        if (node.children && Array.isArray(node.children)) {
          node.children.forEach(child => auditNode(child, currentPath));
        }
      }

      auditNode(localizedVdom, screenId);
    } catch (err) {
      console.warn(`[AUDIT WARNING] Could not parse screen ${screenId}: ${err.message}`);
    }
  }

  // Audit inline client-side showToast / confirm calls in server.js
  const toastRegex = /showToast\(\s*(['"`])(.*?)\1\s*,/g;
  let tMatch;
  while ((tMatch = toastRegex.exec(templates.serverContent)) !== null) {
    const rawToast = tMatch[2];
    if (isSpanishText(rawToast) && !rawToast.includes('currentLang') && !rawToast.includes('t(')) {
      issues.push({
        screen: 'server.js:clientScript',
        id: 'showToast',
        text: rawToast,
        reason: 'Hardcoded Spanish toast message in client script (should use t() or localized string)'
      });
      totalIssues++;
    }
  }

  const confirmRegex = /confirm\(\s*(['"`])(.*?)\1\s*\)/g;
  let cMatch;
  while ((cMatch = confirmRegex.exec(templates.serverContent)) !== null) {
    const rawConfirm = cMatch[2];
    if (isSpanishText(rawConfirm) && !rawConfirm.includes('t(')) {
      issues.push({
        screen: 'server.js:clientScript',
        id: 'confirm',
        text: rawConfirm,
        reason: 'Hardcoded Spanish confirm dialog in client script (should use t())'
      });
      totalIssues++;
    }
  }

  if (totalIssues > 0) {
    console.log(`❌ Found ${totalIssues} leftover Spanish texts or untranslated items:\n`);
    issues.forEach((issue, idx) => {
      console.log(`[#${idx + 1}] Screen: ${issue.screen} | Component: ${issue.id}`);
      if (issue.path) console.log(`    Path: ${issue.path}`);
      console.log(`    Detected Text: "${issue.text}"`);
      console.log(`    Reason: ${issue.reason}`);
      if (issue.stringKey) console.log(`    String Key: ${issue.stringKey}`);
      console.log('');
    });
    console.log(`Audit failed with ${totalIssues} issues.`);
    process.exit(1);
  } else {
    console.log('✅ Audit Passed! All screens and components audited.');
    console.log('Found 0 leftover Spanish texts in English mode');
    process.exit(0);
  }
}

// 8. CLI Runner
function main() {
  const args = process.argv.slice(2);

  if (args.includes('--audit')) {
    runAudit();
    return;
  }

  if (args.includes('--screens')) {
    console.log('Available Screens & Components in Gateway Control Center:');
    Object.keys(SCREENS).forEach(id => console.log(`  - ${id}`));
    return;
  }

  if (args.length >= 2) {
    const lang = args[0].toLowerCase();
    const screenId = args[1];

    if (lang !== 'en' && lang !== 'es') {
      console.error(`Invalid language: "${lang}". Supported: "en", "es".`);
      process.exit(1);
    }

    const screenDef = SCREENS[screenId];
    if (!screenDef) {
      console.error(`Screen "${screenId}" not found. Run --screens to list available screens.`);
      process.exit(1);
    }

    const { en, es } = loadLocales();
    const dict = lang === 'es' ? es : en;
    const templates = extractTemplates();
    const rawHtml = templates[screenDef.source];

    const vdom = parseHtmlToVdom(rawHtml, screenDef.selector);
    const localizedVdom = applyLocalization(vdom, dict);

    console.log(JSON.stringify(localizedVdom, null, 2));
    return;
  }

  console.log(`
Usage:
  node tools/render_ui_tree.js --screens
  node tools/render_ui_tree.js <en|es> <screen_id>
  node tools/render_ui_tree.js --audit

Examples:
  node tools/render_ui_tree.js en cardBrowser
  node tools/render_ui_tree.js es login
  node tools/render_ui_tree.js --audit
  `);
}

main();
