/** Persist one optimistic config patch and reconcile the UI with server state. */
export async function persistConfigPatch(patch, { post, get, onConfig, onNotice, copy }) {
  try {
    const response = await post('/config', patch);
    if (response.ok !== true) throw new Error(String(response.error ?? `HTTP ${response.status ?? 'error'}`));
    onConfig(response.config);
    onNotice(copy.saved);
    return true;
  } catch (error) {
    let detail = String(error?.message ?? error);
    try {
      const latest = await get('/config');
      if (latest.ok && latest.config) onConfig(latest.config);
      else detail = `${detail} (${copy.emptyResponse('/config', latest.status ?? 0)})`;
    } catch { /* keep the last known config and surface the save error */ }
    onNotice(`${copy.saveFailed} ${detail}`);
    return false;
  }
}
