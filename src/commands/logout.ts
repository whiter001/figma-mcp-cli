import { clearCredentials, credentialsPath } from '../auth/store.js';
import { log } from '../util/logger.js';

export function logout(): void {
  const removed = clearCredentials();
  if (removed) {
    log.info(`已清除凭据: ${credentialsPath()}`);
  } else {
    log.info('没有找到本地凭据，无需清理。');
  }
}
