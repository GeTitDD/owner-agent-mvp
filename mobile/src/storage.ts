import * as SecureStore from 'expo-secure-store';
import type { ServerConfig } from './api';

const BASE_URL_KEY = 'owner-companion.baseUrl';
const TOKEN_KEY = 'owner-companion.token';

export async function loadConfig(): Promise<ServerConfig | null> {
  const [baseUrl, token] = await Promise.all([
    SecureStore.getItemAsync(BASE_URL_KEY),
    SecureStore.getItemAsync(TOKEN_KEY)
  ]);
  if (!baseUrl || !token) return null;
  return { baseUrl, token };
}

export async function saveConfig(config: ServerConfig): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(BASE_URL_KEY, config.baseUrl.trim()),
    SecureStore.setItemAsync(TOKEN_KEY, config.token)
  ]);
}

export async function clearConfig(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(BASE_URL_KEY),
    SecureStore.deleteItemAsync(TOKEN_KEY)
  ]);
}
