import { GA4Settings } from '../types';
import { queueBrowserEvent, queueGA4ServerEvent } from './eventBatcher';

declare global {
  interface Window {
    dataLayer: any[];
    gtag: (...args: any[]) => void;
  }
}

let gtagInitialized = false;

export const initGA4 = (settings: GA4Settings) => {
  if (typeof window === 'undefined') return;
  if (!settings.enabled || !settings.measurementId) return;

  if (!gtagInitialized) {
    const script = document.createElement('script');
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${settings.measurementId}`;
    document.head.appendChild(script);

    window.dataLayer = window.dataLayer || [];
    window.gtag = function() {
      window.dataLayer.push(arguments);
    };
    
    window.gtag('js', new Date());
    window.gtag('config', settings.measurementId, {
      send_page_view: false // Manual page_view for SPA to avoid duplicates
    });

    gtagInitialized = true;
  }
};

// SHA-256 hashing for Google Measurement Protocol user_data
async function sha256(text: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(text.trim());
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Google Official normalization for email:
// trim, lowercase, remove dots before @ for gmail.com / googlemail.com
function normalizeEmail(email: string): string {
  let clean = email.trim().toLowerCase();
  const atIndex = clean.indexOf('@');
  if (atIndex > 0) {
    const domain = clean.slice(atIndex + 1);
    let user = clean.slice(0, atIndex);
    if (domain === 'gmail.com' || domain === 'googlemail.com') {
      user = user.replace(/\./g, '');
    }
    clean = `${user}@${domain}`;
  }
  return clean;
}

// Google Official normalization for phone to E.164 (+[country code][number])
function normalizePhoneToE164(phone: string): string {
  let clean = phone.trim().replace(/[^\d+]/g, '');
  if (clean.startsWith('+')) {
    return clean;
  }
  if (clean.startsWith('880')) {
    return `+${clean}`;
  }
  if (clean.startsWith('01')) {
    return `+88${clean}`;
  }
  return clean ? `+${clean}` : '';
}

const getClientId = async (measurementId: string): Promise<string> => {
  // 1. Try reading directly from official _ga cookie: _ga=GA1.1.123456789.1670000000
  if (typeof document !== 'undefined') {
    const gaMatch = document.cookie.match(/_ga=(?:GA\d\.\d\.)?(\d+\.\d+)/);
    if (gaMatch && gaMatch[1]) {
      return gaMatch[1];
    }
  }

  // 2. Try window.gtag('get', measurementId, 'client_id', callback) with strict 500ms timeout race
  if (typeof window !== 'undefined' && window.gtag) {
    try {
      const gtagPromise = new Promise<string>((resolve) => {
        window.gtag('get', measurementId, 'client_id', (clientId: string) => {
          resolve(clientId || '');
        });
      });
      const timeoutPromise = new Promise<string>((resolve) => setTimeout(() => resolve(''), 500));
      const res = await Promise.race([gtagPromise, timeoutPromise]);
      if (res) return res;
    } catch (e) {
      // ignore
    }
  }

  // 3. Fallback to localStorage CID
  return getFallbackClientId();
};

const getFallbackClientId = () => {
  let cid = localStorage.getItem('_ga_fallback_cid');
  if (!cid) {
    cid = `${Math.floor(Math.random() * 1000000000)}.${Math.floor(Date.now() / 1000)}`;
    localStorage.setItem('_ga_fallback_cid', cid);
  }
  return cid;
};

const getSessionId = (): string | undefined => {
  if (typeof document === 'undefined') return undefined;
  // Cookie format: _ga_<CONTAINER_ID>=GS1.1.<session_id>.<session_number>...
  const match = document.cookie.match(/_ga_[A-Z0-9]+=(.*?)(;|$)/);
  if (match && match[1]) {
    const parts = match[1].split('.');
    if (parts.length > 2 && /^\d+$/.test(parts[2])) {
      return parts[2];
    }
  }
  return undefined;
};

// Queue or fire browser event
export const trackGA4BrowserEvent = (eventName: string, eventParams: any, settings: GA4Settings) => {
  if (!settings.enabled || !settings.measurementId || typeof window === 'undefined') return;
  if (!window.gtag) {
    initGA4(settings);
  }
  queueBrowserEvent('ga4', eventName, eventParams);
};

// Fire Server-Side Measurement Protocol
export const trackGA4ServerEvent = async (eventName: string, eventParams: any, settings: GA4Settings, userInfo?: any) => {
  if (!settings.enabled || !settings.measurementId) return;

  const clientId = await getClientId(settings.measurementId);
  const sessionId = getSessionId();

  const params: any = {
    ...eventParams,
    engagement_time_msec: 100,
  };
  if (sessionId) {
    params.session_id = sessionId;
  }

  const payload: any = {
    name: eventName,
    params,
  };

  const hashedUserData: any = {};
  if (userInfo?.email) {
    const cleanEmail = normalizeEmail(userInfo.email);
    if (cleanEmail) {
      hashedUserData.sha256_email = await sha256(cleanEmail);
    }
  }
  if (userInfo?.phone) {
    const cleanPhone = normalizePhoneToE164(userInfo.phone);
    if (cleanPhone) {
      hashedUserData.sha256_phone = await sha256(cleanPhone);
    }
  }

  queueGA4ServerEvent(clientId, payload, Object.keys(hashedUserData).length > 0 ? hashedUserData : undefined);
};

// Unified Event Tracker
export const trackGA4Event = (eventName: string, browserParams: any, serverParams: any | null, settings: GA4Settings, userInfo?: any) => {
  if (!settings.enabled) return;

  // Track on browser
  trackGA4BrowserEvent(eventName, browserParams, settings);

  // If serverParams are defined, track via Measurement Protocol (e.g. for Purchase)
  if (serverParams) {
    trackGA4ServerEvent(eventName, serverParams, settings, userInfo);
  }
};
