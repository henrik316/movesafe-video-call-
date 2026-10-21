export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'dataset') {
      for (const [name, dataValue] of Object.entries(value)) {
        node.dataset[name] = String(dataValue);
      }
      continue;
    }
    if (key === 'class') {
      node.className = value;
      continue;
    }
    if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
      continue;
    }
    if (key === 'htmlFor') {
      node.htmlFor = value;
      continue;
    }
    if (key in node && typeof value !== 'object') {
      try {
        node[key] = value;
        continue;
      } catch {
        /* use the attribute below */
      }
    }
    node.setAttribute(key, value === true ? '' : String(value));
  }
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  node.replaceChildren();
}

let toastTimer;
export function toast(message) {
  let node = document.querySelector('.toast');
  if (!node) {
    node = el('div', { class: 'toast', role: 'status' });
    document.body.appendChild(node);
  }
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 3400);
}

export function mark() {
  const img = el('img', { src: '/favicon.svg', alt: '', width: '36', height: '36' });
  img.className = 'mark';
  return img;
}

export function brand(href) {
  const inner = [
    mark(),
    el('span', { class: 'brand-text' }, [
      el('span', { class: 'brand-name' }, 'MoveSafe'),
      el('span', { class: 'brand-sub' }, 'Relocation'),
    ]),
  ];
  if (!href) return el('div', { class: 'brand' }, inner);
  return el('a', { class: 'brand', href }, inner);
}
