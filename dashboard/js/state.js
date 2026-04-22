import { STORAGE_KEY, DEFAULT_URL } from './constants.js';
import { sanitizeTargetURL } from './utils.js';

export let targetURL = sanitizeTargetURL(localStorage.getItem(STORAGE_KEY) || DEFAULT_URL) ?? DEFAULT_URL;

export function setTargetURL(url) {
  targetURL = url;
  localStorage.setItem(STORAGE_KEY, url);
}
