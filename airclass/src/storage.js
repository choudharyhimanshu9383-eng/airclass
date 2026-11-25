const KEY = "airclass.profiles.v1";

export function loadProfiles() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
}

export function saveProfile(name, data) {
  const all = loadProfiles();
  all[name] = { name, ...data, savedAt: Date.now() };
  localStorage.setItem(KEY, JSON.stringify(all));
  return all;
}

export function deleteProfile(name) {
  const all = loadProfiles();
  delete all[name];
  localStorage.setItem(KEY, JSON.stringify(all));
  return all;
}

export function loadResults() {
  try {
    return JSON.parse(localStorage.getItem("airclass.results.v1")) || [];
  } catch {
    return [];
  }
}

export function saveResult(r) {
  const list = loadResults();
  list.push({ ...r, at: Date.now() });
  localStorage.setItem("airclass.results.v1", JSON.stringify(list));
  return list;
}

export function clearResults() {
  localStorage.setItem("airclass.results.v1", "[]");
  return [];
}
