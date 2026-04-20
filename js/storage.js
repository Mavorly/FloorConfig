// Profile persistence via LocalStorage.

const KEY = 'floorconfig:profiles:v1';

export function loadProfiles() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch { return {}; }
}

export function saveProfiles(profiles) {
  localStorage.setItem(KEY, JSON.stringify(profiles));
}

export function saveProfile(name, data) {
  const p = loadProfiles();
  p[name] = { ...data, savedAt: new Date().toISOString() };
  saveProfiles(p);
  return p;
}

export function deleteProfile(name) {
  const p = loadProfiles();
  delete p[name];
  saveProfiles(p);
  return p;
}

export function getProfile(name) {
  const p = loadProfiles();
  return p[name] || null;
}

export function listProfiles() {
  return Object.keys(loadProfiles()).sort((a, b) => a.localeCompare(b));
}
