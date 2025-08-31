import browser from "webextension-polyfill";
import log from "loglevel";
import { getSettings } from "src/settings/settings";

const logDir = "common/translate";

const getHistory = async (sourceWord, sourceLang, targetLang, translationApi) => {
  const result = await browser.storage.session.get(`${sourceLang}-${targetLang}-${translationApi}-${sourceWord}`);
  return result[`${sourceLang}-${targetLang}-${translationApi}-${sourceWord}`] ?? false;
};

const setHistory = async (sourceWord, sourceLang, targetLang, translationApi, result) => {
  if (result.isError) return;
  await browser.storage.session.set({ [`${sourceLang}-${targetLang}-${translationApi}-${sourceWord}`]: result });
};

const sendRequestToGoogle = async (word, sourceLang, targetLang) => {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sourceLang}&tl=${targetLang}&dt=t&dt=bd&dj=1&q=${encodeURIComponent(
    word
  )}`;
  const response = await fetch(url).catch(e => ({ status: 0, statusText: '' }));

  const resultData = {
    resultText: "",
    candidateText: "",
    sourceLanguage: "",
    percentage: 0,
    isError: false,
    errorMessage: ""
  };

  if (response.status !== 200) {
    resultData.isError = true;

    if (response.status === 0) resultData.errorMessage = browser.i18n.getMessage("networkError");
    else if (response.status === 429 || response.status === 503) resultData.errorMessage = browser.i18n.getMessage("unavailableError");
    else resultData.errorMessage = `${browser.i18n.getMessage("unknownError")} [${response.status} ${response.statusText}]`;

    log.error(logDir, "sendRequest()", response);
    return resultData;
  }

  const result = await response.json();

  resultData.sourceLanguage = result.src;
  resultData.percentage = result.ld_result.srclangs_confidences[0];
  resultData.resultText = result.sentences.map(sentence => sentence.trans).join("");
  if (result.dict) {
    resultData.candidateText = result.dict
      .map(dict => `${dict.pos}${dict.pos != "" ? ": " : ""}${dict.terms !== undefined?dict.terms.join(", "):""}\n`)
      .join("");
  }

  log.log(logDir, "sendRequest()", resultData);
  return resultData;
};


const sendRequestToDeepL = async (word, sourceLang, targetLang) => {
  let params = new URLSearchParams();
  const authKey = getSettings("deeplAuthKey");
  params.append("auth_key", authKey);
  params.append("text", word);
  params.append("target_lang", targetLang);
  const url = getSettings("deeplPlan") === "deeplFree" ?
    "https://api-free.deepl.com/v2/translate" :
    "https://api.deepl.com/v2/translate";

  const response = await fetch(url, {
    method: "POST",
    body: params
  }).catch(e => ({ status: 0, statusText: '' }));

  const resultData = {
    resultText: "",
    candidateText: "",
    sourceLanguage: "",
    percentage: 0,
    isError: false,
    errorMessage: ""
  };

  if (response.status !== 200) {
    resultData.isError = true;

    if (response.status === 0) resultData.errorMessage = browser.i18n.getMessage("networkError");
    else if (response.status === 403) resultData.errorMessage = browser.i18n.getMessage("deeplAuthError");
    else resultData.errorMessage = `${browser.i18n.getMessage("unknownError")} [${response.status} ${response.statusText}]`;

    log.error(logDir, "sendRequestToDeepL()", response);
    return resultData;
  }

  const result = await response.json();

  resultData.resultText = result.translations[0].text;
  resultData.sourceLanguage = result.translations[0].detected_source_language.toLowerCase();
  resultData.percentage = 1;

  log.log(logDir, "sendRequestToDeepL()", resultData);
  return resultData;
};

const sendRequestToYoudao = async (word, sourceLang, targetLang) => {
  const appKey = getSettings("youdaoAppKey");
  const appSecret = getSettings("youdaoAppSecret");
  const salt = Date.now().toString();
  const curtime = Math.floor(Date.now() / 1000).toString();
  // Truncate logic per docs
  function truncate(q) {
    const len = q.length;
    if (len <= 20) return q;
    return q.substring(0, 10) + len + q.substring(len - 10, len);
  }
  const input = truncate(word);
  const signStr = appKey + input + salt + curtime + appSecret;
  // Use SubtleCrypto for SHA256
  async function sha256(str) {
    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    const hashBuffer = await (window.crypto.subtle.digest("SHA-256", data));
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
  }
  const sign = await sha256(signStr);
  const params = {
    q: word,
    from: sourceLang,
    to: targetLang,
    appKey,
    salt,
    sign,
    signType: "v3",
    curtime
  };
  const url = "https://openapi.youdao.com/api";
  const formBody = Object.keys(params).map(key => `${key}=${encodeURIComponent(params[key])}`).join("&");
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody
  }).catch(e => ({ status: 0, statusText: '' }));

  const resultData = {
    resultText: "",
    candidateText: "",
    sourceLanguage: sourceLang,
    percentage: 1,
    isError: false,
    errorMessage: ""
  };

  if (!response || response.status !== 200) {
    resultData.isError = true;
    if (!response || response.status === 0) resultData.errorMessage = browser.i18n.getMessage("networkError");
    else resultData.errorMessage = `${browser.i18n.getMessage("unknownError")} [${response.status} ${response.statusText}]`;
    log.error(logDir, "sendRequestToYoudao()", response);
    return resultData;
  }
  const result = await response.json();
  if (result.errorCode && result.errorCode !== "0") {
    resultData.isError = true;
    resultData.errorMessage = result.errorCode;
    log.error(logDir, "sendRequestToYoudao()", result);
    return resultData;
  }
  resultData.resultText = result.translation ? result.translation.join("\n") : "";
  // Youdao v3 no longer returns basic.explains, so skip candidateText
  log.log(logDir, "sendRequestToYoudao()", resultData);
  return resultData;
};


export default async (sourceWord, sourceLang = "auto", targetLang) => {
  log.log(logDir, "tranlate()", sourceWord, targetLang);
  sourceWord = sourceWord.trim();
  if (sourceWord === "")
    return {
      resultText: "",
      candidateText: "",
      sourceLanguage: "en",
      percentage: 0,
      statusText: "OK"
    };

  const translationApi = getSettings("translationApi");

  const cachedResult = await getHistory(sourceWord, sourceLang, targetLang, translationApi);
  if (cachedResult) return cachedResult;

  let result;
  if (translationApi === "google") {
    result = await sendRequestToGoogle(sourceWord, sourceLang, targetLang);
  } else if (translationApi === "deepl") {
    result = await sendRequestToDeepL(sourceWord, sourceLang, targetLang);
  } else if (translationApi === "youdao") {
    result = await sendRequestToYoudao(sourceWord, sourceLang, targetLang);
  } else {
    result = await sendRequestToGoogle(sourceWord, sourceLang, targetLang);
  }
  setHistory(sourceWord, sourceLang, targetLang, translationApi, result);
  return result;
};
