/** Per-device display preferences (text size, contrast). Storage may be unavailable, so it is optional. */

const KEY = 'kendra.display';
const SCALES = [0.9, 1, 1.15, 1.3, 1.5];

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
}

function save(prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* storage blocked: preferences simply won't persist */
  }
}

export function initPreferences() {
  const prefs = { scaleIndex: 1, contrast: false, ...load() };
  const root = document.documentElement;
  const contrastButton = document.getElementById('contrast-toggle');

  const apply = () => {
    root.style.setProperty('--scale', String(SCALES[prefs.scaleIndex]));
    root.dataset.contrast = prefs.contrast ? 'high' : 'normal';
    contrastButton.setAttribute('aria-pressed', String(prefs.contrast));
    save(prefs);
  };

  document.getElementById('text-larger').addEventListener('click', () => {
    prefs.scaleIndex = Math.min(SCALES.length - 1, prefs.scaleIndex + 1);
    apply();
  });
  document.getElementById('text-smaller').addEventListener('click', () => {
    prefs.scaleIndex = Math.max(0, prefs.scaleIndex - 1);
    apply();
  });
  contrastButton.addEventListener('click', () => {
    prefs.contrast = !prefs.contrast;
    apply();
  });
  apply();
}
