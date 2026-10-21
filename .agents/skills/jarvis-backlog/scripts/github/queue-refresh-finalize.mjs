export async function refreshAfterQueue(result, refresh) {
  if (result.mode !== 'updated' && result.mode !== 'unchanged') return null;
  try { return await refresh(); }
  catch { return JSON.stringify({mainRefresh:'skipped', reason:'trusted App helper was unavailable'}); }
}
