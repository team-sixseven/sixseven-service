export async function getServiceStatus(signal: AbortSignal) {
  const timeout = AbortSignal.timeout(5000);
  const requestSignal = AbortSignal.any([signal, timeout]);

  try {
    const [healthResponse, modelResponse] = await Promise.all([
      fetch('/api/health', { signal: requestSignal, cache: 'no-store' }),
      fetch('/api/model', { signal: requestSignal, cache: 'no-store' }),
    ]);
    if (!healthResponse.ok || !modelResponse.ok) {
      throw new Error('서버 연결을 확인할 수 없습니다.');
    }
    const [health, model] = await Promise.all([healthResponse.json(), modelResponse.json()]);
    if (health.status !== 'ok' || health.database !== 'sqlite'
      || model.status !== 'not_connected' || model.model_id !== null) {
      throw new Error('서버 응답을 확인해 주세요.');
    }
    return { database: 'SQLite', model: '미연결' };
  } catch (error) {
    if (timeout.aborted) throw new Error('서버 응답 시간이 초과되었습니다.');
    throw error;
  }
}
