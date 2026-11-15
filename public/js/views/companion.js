import { h, mount, toast } from '../dom.js';
import { api } from '../api.js';

/**
 * Voice-first Care Companion (English / ಕನ್ನಡ).
 * Speech-to-text and text-to-speech use the browser's Web Speech API; answers come
 * from the server, which only reads the elder's records through fixed tools.
 */

const LANG = {
  en: { code: 'en-IN', label: 'English', placeholder: 'Type your question', send: 'Ask', listen: 'Tap and speak', listening: 'Listening…' },
  kn: { code: 'kn-IN', label: 'ಕನ್ನಡ', placeholder: 'ನಿಮ್ಮ ಪ್ರಶ್ನೆಯನ್ನು ಬರೆಯಿರಿ', send: 'ಕೇಳಿ', listen: 'ಒತ್ತಿ ಮಾತನಾಡಿ', listening: 'ಕೇಳುತ್ತಿದೆ…' },
};

const SUGGESTIONS = {
  en: ['Which medicine should I take this morning?', 'Have I confirmed my morning medicine?', 'When is my next doctor appointment?', 'Which tablets are running low?'],
  kn: ['ನಾನು ಇವತ್ತು ಬೆಳಿಗ್ಗೆ ಔಷಧಿ ತೆಗೆದುಕೊಂಡಿದ್ದೇನಾ?', 'ನನ್ನ ಮುಂದಿನ ಡಾಕ್ಟರ್ ಅಪಾಯಿಂಟ್ಮೆಂಟ್ ಯಾವಾಗ?', 'ಈಗ ಯಾವ ಔಷಧಿ ತೆಗೆದುಕೊಳ್ಳಬೇಕು?'],
};

const SOURCE_LABEL = { records: 'From your records', safety: 'Safety response', general: 'General help' };
const PREF_KEY = 'kendra.companion.lang';

function loadLang() {
  try {
    return localStorage.getItem(PREF_KEY) === 'kn' ? 'kn' : 'en';
  } catch {
    return 'en';
  }
}

function saveLang(lang) {
  try {
    localStorage.setItem(PREF_KEY, lang);
  } catch {
    /* preference simply won't persist */
  }
}

function speak(text, lang) {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = LANG[lang].code;
  const voice = window.speechSynthesis.getVoices().find((v) => v.lang?.toLowerCase().startsWith(lang));
  if (voice) utterance.voice = voice;
  utterance.rate = 0.9;
  window.speechSynthesis.speak(utterance);
}

// The transcript survives re-renders (e.g. the minute-by-minute dashboard refresh).
const transcript = [];

export function renderCompanion(root) {
  let lang = loadLang();
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const chat = h('div', { class: 'chat', role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversation' });
  const input = h('input', { type: 'text', id: 'companion-input', maxlength: 300, autocomplete: 'off' });
  const micLabel = h('p', { class: 'muted', style: 'text-align:center;margin:0.4rem 0 0' });
  const mic = h('button', { type: 'button', class: 'mic', 'aria-pressed': 'false' }, '\u{1F3A4}');
  const suggestions = h('div', { class: 'suggestions', role: 'group', 'aria-label': 'Example questions' });
  const langButtons = Object.keys(LANG).map((code) => h('button', { type: 'button', 'aria-pressed': String(code === lang), lang: code === 'kn' ? 'kn' : 'en' }, LANG[code].label));

  const bubble = (entry) =>
    h(
      'div',
      { class: `bubble ${entry.who}`, lang: entry.lang },
      entry.text,
      entry.source ? h('div', { class: 'small', style: 'margin-top:0.35rem;opacity:0.8' }, `— ${SOURCE_LABEL[entry.source] || ''}${entry.classifiedBy === 'gemini' ? ' · intent by Gemini' : ''}`) : null,
    );
  const renderChat = () => {
    chat.replaceChildren(
      ...(transcript.length
        ? transcript.map(bubble)
        : [bubble({ who: 'kendra', lang, text: lang === 'kn' ? 'ನಮಸ್ಕಾರ! ನಿಮ್ಮ ಔಷಧಿ ಅಥವಾ ಅಪಾಯಿಂಟ್ಮೆಂಟ್ ಬಗ್ಗೆ ಕೇಳಿ.' : 'Namaste! Ask me about your medicines, confirmations or appointments.' })]),
    );
    chat.scrollTop = chat.scrollHeight;
  };

  async function ask(text) {
    const question = text.trim();
    if (!question) return;
    transcript.push({ who: 'me', text: question, lang });
    renderChat();
    input.value = '';
    try {
      const reply = await api.post('/api/ai/companion', { text: question, language: lang });
      transcript.push({ who: 'kendra', text: reply.answer, lang: reply.language, source: reply.source, classifiedBy: reply.classifiedBy });
      renderChat();
      speak(reply.answer, reply.language);
    } catch (error) {
      toast(error.message, { error: true });
    }
  }

  const applyLang = () => {
    langButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(Object.keys(LANG)[i] === lang)));
    input.placeholder = LANG[lang].placeholder;
    sendButton.textContent = LANG[lang].send;
    micLabel.textContent = Recognition ? LANG[lang].listen : 'Voice input is not supported in this browser. Please type instead.';
    mic.disabled = !Recognition;
    suggestions.replaceChildren(...SUGGESTIONS[lang].map((q) => h('button', { type: 'button', class: 'secondary', lang, onClick: () => ask(q) }, q)));
    renderChat();
  };

  langButtons.forEach((button, i) =>
    button.addEventListener('click', () => {
      lang = Object.keys(LANG)[i];
      saveLang(lang);
      applyLang();
    }),
  );

  let recognition = null;
  mic.addEventListener('click', () => {
    if (!Recognition) return;
    if (recognition) {
      recognition.stop();
      return;
    }
    recognition = new Recognition();
    recognition.lang = LANG[lang].code;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    mic.setAttribute('aria-pressed', 'true');
    micLabel.textContent = LANG[lang].listening;
    recognition.onresult = (event) => ask(event.results[0][0].transcript);
    recognition.onerror = (event) => {
      const help = {
        'not-allowed': 'Microphone access is blocked. Click the icon left of the address bar, allow the microphone, then reload.',
        'service-not-allowed': 'Microphone access is blocked. Click the icon left of the address bar, allow the microphone, then reload.',
        'audio-capture': 'No microphone was found. Please connect one, or type your question.',
        network: 'Voice recognition needs an internet connection. Please type your question instead.',
        'language-not-supported': 'This browser cannot recognise this language by voice. Please type, or try Chrome.',
      };
      if (event.error !== 'no-speech' && event.error !== 'aborted') toast(help[event.error] || `Voice input stopped (${event.error}). You can type instead.`, { error: true });
    };
    recognition.onend = () => {
      recognition = null;
      mic.setAttribute('aria-pressed', 'false');
      micLabel.textContent = LANG[lang].listen;
    };
    recognition.start();
  });

  const sendButton = h('button', { type: 'submit' });
  const form = h('form', { class: 'row', novalidate: true }, h('label', { for: 'companion-input', class: 'visually-hidden' }, 'Your question'), h('div', { style: 'flex:1;min-width:220px' }, input), sendButton);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    ask(input.value);
  });
  mic.setAttribute('aria-label', 'Speak your question');

  mount(
    root,
    h(
      'div',
      { class: 'stack' },
      h('div', { class: 'row spread' }, h('div', {}, h('h2', { style: 'margin:0' }, 'Care Companion'), h('p', { class: 'muted', style: 'margin:0' }, 'Answers only from your own records. It never gives medical advice.')), h('div', { class: 'seg', role: 'group', 'aria-label': 'Language' }, langButtons)),
      h('section', { class: 'panel stack' }, chat, h('div', {}, mic, micLabel), form, suggestions),
      h('p', { class: 'small muted' }, 'In an emergency, call 112. Kendra cannot assess symptoms or change medicines; please ask your doctor about any change.'),
    ),
  );
  applyLang();
}
