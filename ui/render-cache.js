// Keep interactive nodes (and keyboard focus/open menus) across identical polls.
const rendered = new WeakMap();
export function renderWhenChanged(target, key, render) {
  if (rendered.get(target) === key) return false;
  render();
  rendered.set(target, key);
  return true;
}
