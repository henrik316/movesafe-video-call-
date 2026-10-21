const PATHS = {
  mic: '<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"/><path d="M6 11a6 6 0 0 0 12 0"/><path d="M12 17v4"/><path d="M8 21h8"/>',
  micOff: '<path d="M9 9v1a3 3 0 0 0 5.1 2.1"/><path d="M15 9.5V6a3 3 0 0 0-5.2-2"/><path d="M6 11a6 6 0 0 0 9.2 5"/><path d="M12 17v4"/><path d="M8 21h8"/><path d="M4 4l16 16"/>',
  cam: '<path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h8A2.5 2.5 0 0 1 16 8.5v7A2.5 2.5 0 0 1 13.5 18h-8A2.5 2.5 0 0 1 3 15.5v-7Z"/><path d="M16 11l5-3v8l-5-3"/>',
  camOff: '<path d="M3 8.5A2.5 2.5 0 0 1 5.5 6H8"/><path d="M16 8.5V15l-5 3H5.5A2.5 2.5 0 0 1 3 15.5V12"/><path d="M16 11l5-3v8l-3-1.8"/><path d="M4 4l16 16"/>',
  flip: '<path d="M7 7H4v3"/><path d="M4 7a8 8 0 0 1 13.5-2"/><path d="M17 17h3v-3"/><path d="M20 17a8 8 0 0 1-13.5 2"/><circle cx="12" cy="12" r="2"/>',
  record: '<circle cx="12" cy="12" r="6" fill="currentColor" stroke="none"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.1.1l1.5-1.5a5 5 0 0 0-7.1-7.1L10.2 5.8"/><path d="M14 11a5 5 0 0 0-7.1-.1L5.4 12.4a5 5 0 0 0 7.1 7.1l1.3-1.3"/>',
  leave: '<path d="M10 7V5a2 2 0 0 1 2-2h7v18h-7a2 2 0 0 1-2-2v-2"/><path d="M4 12h10"/><path d="M11 9l3 3-3 3"/>',
  play: '<path d="M9 7.5v9l8-4.5-8-4.5Z" fill="currentColor" stroke="none"/>',
  download: '<path d="M12 4v10"/><path d="M8 10l4 4 4-4"/><path d="M5 19h14"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M7 7l1 13h8l1-13"/>',
  box: '<path d="M3 8l9-4 9 4-9 4-9-4Z"/><path d="M3 8v8l9 4 9-4V8"/><path d="M12 12v8"/>',
};

export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  svg.innerHTML = PATHS[name] || '';
  return svg;
}
