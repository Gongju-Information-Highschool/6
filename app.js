/* AI 기반 구조요청 신호탐지 시스템 — 빌드 도구 없는 수업용 정적 웹앱 */
(function () {
  'use strict';

  var ALARM_KEYWORDS = ['비명', '도움', '구조', '살려', '두드', '노크', '타격', 'help', 'scream', 'knock'];
  var NOISE_KEYWORDS = ['배경', '소음', '정적', '무음', 'background', 'noise', 'unknown', '_background_noise_'];
  var FALLBACK_DESCRIPTION = '구조요청으로 추정되는 신호가 감지되었습니다. 즉시 현장 확인이 필요합니다.';
  var ALARM_RELEASE_MS = 4000;
  var MOCK_INTERVAL_MS = 900;
  var MOCK_LABELS = ['배경 소음', '비명·도움 요청', '두드림'];

  var state = {
    recognizer: null,
    loadedModelUrl: '',
    labels: [],
    alarmLabels: {},
    listening: false,
    mock: false,
    mockTimer: null,
    threshold: 0.75,
    alarmActive: false,
    alarmTimer: null,
    sirenNodes: null,
    muted: false,
    logCount: 0,
    audioCtx: null
  };

  function $(id) { return document.getElementById(id); }

  var dom = {
    modelUrl: $('modelUrl'),
    geminiKey: $('geminiKey'),
    mockMode: $('mockMode'),
    muteSiren: $('muteSiren'),
    threshold: $('threshold'),
    thresholdValue: $('thresholdValue'),
    startBtn: $('startBtn'),
    stopBtn: $('stopBtn'),
    message: $('message'),
    labelSection: $('labelSection'),
    labelChecks: $('labelChecks'),
    gauges: $('gauges'),
    statusLight: $('statusLight'),
    statusText: $('statusText'),
    statusSub: $('statusSub'),
    modePill: $('modePill'),
    alertOverlay: $('alertOverlay'),
    alertDetail: $('alertDetail'),
    logBody: $('logBody'),
    logEmpty: $('logEmpty'),
    logCount: $('logCount'),
    clearLog: $('clearLog'),
    systemClock: $('systemClock')
  };

  function showMessage(text, kind) {
    dom.message.textContent = text;
    dom.message.className = 'message message-' + (kind || 'info');
  }

  function hideMessage() {
    dom.message.textContent = '';
    dom.message.className = 'message hidden';
  }

  function setStatus(kind, title, detail) {
    dom.statusLight.className = 'status-light status-' + kind;
    dom.statusText.textContent = title;
    dom.statusSub.textContent = detail;
  }

  function setMode(text, kind) {
    dom.modePill.className = 'mode-pill mode-' + kind;
    dom.modePill.innerHTML = '<i></i>' + escapeHtml(text);
  }

  function escapeHtml(text) {
    var node = document.createElement('div');
    node.textContent = String(text);
    return node.innerHTML;
  }

  function escapeAttribute(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function containsKeyword(label, keywords) {
    var value = label.toLowerCase();
    return keywords.some(function (keyword) {
      return value.indexOf(keyword.toLowerCase()) !== -1;
    });
  }

  function looksLikeAlarm(label) { return containsKeyword(label, ALARM_KEYWORDS); }
  function looksLikeNoise(label) { return containsKeyword(label, NOISE_KEYWORDS); }

  function setLabels(labels) {
    state.labels = labels.slice();
    state.alarmLabels = {};

    var matched = labels.filter(looksLikeAlarm);
    labels.forEach(function (label) {
      state.alarmLabels[label] = matched.length ? looksLikeAlarm(label) : !looksLikeNoise(label);
    });

    renderLabelChecks();
    buildGauges();
    renderGauges(labels.map(function () { return 0; }));
  }

  function renderLabelChecks() {
    dom.labelSection.classList.remove('hidden');
    dom.labelChecks.innerHTML = '';

    state.labels.forEach(function (label) {
      var wrapper = document.createElement('label');
      wrapper.className = 'label-chip';

      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = Boolean(state.alarmLabels[label]);
      checkbox.setAttribute('aria-label', label + '을 경보 대상으로 지정');
      checkbox.addEventListener('change', function () {
        state.alarmLabels[label] = checkbox.checked;
      });

      var text = document.createElement('span');
      text.textContent = label;
      wrapper.appendChild(checkbox);
      wrapper.appendChild(text);
      dom.labelChecks.appendChild(wrapper);
    });
  }

  function buildGauges() {
    dom.gauges.innerHTML = '';
    state.labels.forEach(function (label, index) {
      var row = document.createElement('div');
      row.className = 'gauge-row';
      row.innerHTML =
        '<div class="gauge-meta">' +
          '<span class="gauge-label">' + escapeHtml(label) + '</span>' +
          '<span class="gauge-value" data-value="' + index + '">0.0%</span>' +
        '</div>' +
        '<div class="gauge-track" role="progressbar" aria-label="' + escapeAttribute(label) + ' 확률" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" data-track="' + index + '">' +
          '<div class="gauge-bar" data-bar="' + index + '"></div>' +
        '</div>';
      dom.gauges.appendChild(row);
    });
  }

  function renderGauges(scores) {
    state.labels.forEach(function (label, index) {
      var score = Number(scores[index]) || 0;
      var percentage = Math.max(0, Math.min(100, score * 100));
      var value = dom.gauges.querySelector('[data-value="' + index + '"]');
      var track = dom.gauges.querySelector('[data-track="' + index + '"]');
      var bar = dom.gauges.querySelector('[data-bar="' + index + '"]');
      if (!value || !track || !bar) return;

      value.textContent = percentage.toFixed(1) + '%';
      track.setAttribute('aria-valuenow', percentage.toFixed(1));
      bar.style.width = percentage.toFixed(1) + '%';
      bar.className = 'gauge-bar' + (
        state.alarmLabels[label] && score >= state.threshold ? ' is-alarm' :
        state.alarmLabels[label] ? ' is-target' : ''
      );
    });
  }

  function handleScores(scores) {
    if (!scores.length || scores.length !== state.labels.length) return;
    renderGauges(scores);

    var topIndex = 0;
    var alarmIndex = -1;
    for (var index = 0; index < scores.length; index += 1) {
      if (scores[index] > scores[topIndex]) topIndex = index;
      if (state.alarmLabels[state.labels[index]] && (alarmIndex < 0 || scores[index] > scores[alarmIndex])) {
        alarmIndex = index;
      }
    }

    if (alarmIndex >= 0 && scores[alarmIndex] >= state.threshold) {
      triggerAlarm(state.labels[alarmIndex], scores[alarmIndex]);
      return;
    }

    if (!isAlarmVisible()) {
      setStatus('normal', '정상 감시 중', '최다 감지: ' + state.labels[topIndex] + ' · ' + (scores[topIndex] * 100).toFixed(1) + '%');
    }
  }

  function isAlarmVisible() {
    return !dom.alertOverlay.classList.contains('hidden');
  }

  function triggerAlarm(label, probability) {
    dom.alertOverlay.classList.remove('hidden');
    dom.alertDetail.textContent = label + ' · ' + (probability * 100).toFixed(1) + '%';
    setStatus('alarm', '구조요청 신호 감지', label + ' · ' + (probability * 100).toFixed(1) + '%');

    clearTimeout(state.alarmTimer);
    state.alarmTimer = setTimeout(clearAlarm, ALARM_RELEASE_MS);

    /* 동일 경보 구간에서는 화면만 갱신하고 사이렌·로그·API 요청은 반복하지 않는다. */
    if (state.alarmActive) return;
    state.alarmActive = true;

    playSiren();
    var row = addLogRow(label, probability);
    describeWithGemini(label, probability).then(function (description) {
      if (row.description.isConnected) row.description.textContent = description;
    });
  }

  function clearAlarm() {
    dom.alertOverlay.classList.add('hidden');
    state.alarmActive = false;
    state.alarmTimer = null;
    if (state.listening) setStatus('normal', '정상 감시 중', '경보가 해제되어 다시 감시합니다.');
  }

  function addLogRow(label, probability) {
    if (dom.logEmpty && dom.logEmpty.parentNode) dom.logEmpty.remove();

    var row = document.createElement('tr');
    row.className = 'log-new';
    var time = new Date().toLocaleTimeString('ko-KR', { hour12: false });
    row.innerHTML =
      '<td class="log-time"></td>' +
      '<td class="log-signal"></td>' +
      '<td class="log-probability"></td>' +
      '<td class="log-description">설명 생성 중…</td>';
    row.children[0].textContent = time;
    row.children[1].textContent = label;
    row.children[2].textContent = (probability * 100).toFixed(1) + '%';
    dom.logBody.insertBefore(row, dom.logBody.firstChild);

    state.logCount += 1;
    dom.logCount.textContent = state.logCount + '건';
    return { description: row.children[3] };
  }

  function clearLogs() {
    dom.logBody.innerHTML = '';
    dom.logBody.appendChild(dom.logEmpty);
    state.logCount = 0;
    dom.logCount.textContent = '0건';
  }

  function ensureAudio() {
    try {
      if (!state.audioCtx) {
        var AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        state.audioCtx = new AudioContext();
      }
      if (state.audioCtx.state === 'suspended') state.audioCtx.resume();
    } catch (error) {
      console.warn('오디오를 준비하지 못했습니다.', error);
    }
  }

  function stopSiren() {
    if (!state.sirenNodes || !state.audioCtx) return;
    try {
      var now = state.audioCtx.currentTime;
      var nodes = state.sirenNodes;
      nodes.gain.gain.cancelScheduledValues(now);
      nodes.gain.gain.setValueAtTime(Math.max(nodes.gain.gain.value, 0.0001), now);
      nodes.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.02);
      nodes.oscillator.stop(now + 0.03);
    } catch (error) {
      /* 이미 종료된 오디오 노드는 무시한다. */
    }
    state.sirenNodes = null;
  }

  function playSiren() {
    if (state.muted) return;
    try {
      ensureAudio();
      if (!state.audioCtx) return;
      stopSiren();

      var context = state.audioCtx;
      var oscillator = context.createOscillator();
      var gain = context.createGain();
      var now = context.currentTime;

      oscillator.type = 'sawtooth';
      oscillator.frequency.setValueAtTime(660, now);
      for (var turn = 0; turn < 3; turn += 1) {
        oscillator.frequency.linearRampToValueAtTime(1100, now + 0.3 + turn * 0.6);
        oscillator.frequency.linearRampToValueAtTime(660, now + 0.6 + turn * 0.6);
      }

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.22, now + 0.05);
      gain.gain.setValueAtTime(0.22, now + 1.6);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.85);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(now);
      oscillator.stop(now + 1.9);

      state.sirenNodes = { oscillator: oscillator, gain: gain };
      oscillator.onended = function () {
        if (state.sirenNodes && state.sirenNodes.oscillator === oscillator) state.sirenNodes = null;
      };
    } catch (error) {
      console.warn('사이렌을 재생하지 못했습니다.', error);
    }
  }

  function describeWithGemini(label, probability) {
    var key = dom.geminiKey.value.trim();
    if (!key) return Promise.resolve(FALLBACK_DESCRIPTION);

    var prompt = '재난 관제용 음향 AI가 "' + label + '" 신호를 ' +
      (probability * 100).toFixed(1) + '% 확률로 감지했다. 구조대원에게 전달할 상황과 긴급도를 한국어 한 문장, 60자 이내로만 작성해라.';

    return fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.5, maxOutputTokens: 200, thinkingConfig: { thinkingBudget: 0 } }
      })
    }).then(function (response) {
      if (!response.ok) throw new Error('Gemini 응답 오류: ' + response.status);
      return response.json();
    }).then(function (data) {
      var parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
      var description = parts ? parts.map(function (part) { return part.text || ''; }).join('').trim() : '';
      return description || FALLBACK_DESCRIPTION;
    }).catch(function (error) {
      console.warn('Gemini 설명 대신 기본 문구를 사용합니다.', error);
      return FALLBACK_DESCRIPTION;
    });
  }

  function createRecognizer(modelUrl) {
    var baseUrl = modelUrl.charAt(modelUrl.length - 1) === '/' ? modelUrl : modelUrl + '/';
    var recognizer = speechCommands.create('BROWSER_FFT', undefined, baseUrl + 'model.json', baseUrl + 'metadata.json');
    return recognizer.ensureModelLoaded().then(function () { return recognizer; });
  }

  function startLive() {
    var url = dom.modelUrl.value.trim();
    if (!url) {
      showMessage('모델 주소를 입력하세요. 모델이 없다면 Mock 모드로 먼저 시험할 수 있습니다.', 'error');
      return Promise.reject(new Error('모델 주소 없음'));
    }

    try {
      var parsedUrl = new URL(url);
      var isSecureRemote = parsedUrl.protocol === 'https:';
      var isLocalTest = parsedUrl.protocol === 'http:' && parsedUrl.hostname === 'localhost';
      if (!isSecureRemote && !isLocalTest) throw new Error('안전하지 않은 주소');
    } catch (error) {
      showMessage('올바른 HTTPS 모델 주소를 입력하세요.', 'error');
      return Promise.reject(new Error('잘못된 모델 주소'));
    }

    if (!window.speechCommands) {
      showMessage('AI 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인하고 새로고침해 주세요.', 'error');
      return Promise.reject(new Error('라이브러리 로드 실패'));
    }

    showMessage('AI 모델을 불러오고 있습니다…', 'info');
    var loader = state.recognizer && state.loadedModelUrl === url
      ? Promise.resolve(state.recognizer)
      : createRecognizer(url);

    return loader.then(function (recognizer) {
      state.recognizer = recognizer;
      state.loadedModelUrl = url;
      setLabels(recognizer.wordLabels());

      return recognizer.listen(function (result) {
        /* result.scores[i]는 wordLabels()[i]와 순서로 대응한다. */
        handleScores(Array.prototype.slice.call(result.scores));
      }, {
        includeSpectrogram: false,
        probabilityThreshold: 0,
        invokeCallbackOnNoiseAndUnknown: true,
        overlapFactor: 0.5
      });
    }).then(function () {
      hideMessage();
      setMode('실시간 감지 중', 'live');
      setStatus('normal', '정상 감시 중', '마이크 입력을 실시간으로 분석하고 있습니다.');
    }).catch(function (error) {
      var message = String(error && (error.message || error));
      if (error && (error.name === 'NotAllowedError' || /permission|notallowed/i.test(message))) {
        showMessage('마이크 권한이 거부되었습니다. 주소창의 자물쇠 아이콘에서 마이크를 허용한 뒤 다시 시작하세요.', 'error');
      } else if (!/모델 주소 없음|잘못된 모델 주소|라이브러리 로드 실패/.test(message)) {
        showMessage('모델을 불러오지 못했습니다. 주소가 정확한지, 페이지를 HTTPS 또는 localhost에서 열었는지 확인하세요.', 'error');
      }
      throw error;
    });
  }

  function makeNormalDistribution(length) {
    var values = [];
    var sum = 0;
    for (var index = 0; index < length; index += 1) {
      var value = Math.random() + 0.05;
      values.push(value);
      sum += value;
    }
    return values.map(function (value) { return value / sum; });
  }

  function addMockSpike(scores) {
    var candidates = [];
    state.labels.forEach(function (label, index) {
      if (state.alarmLabels[label]) candidates.push(index);
    });
    if (!candidates.length) return scores;

    var chosen = candidates[Math.floor(Math.random() * candidates.length)];
    var spike = state.threshold + Math.random() * Math.max(0, 0.99 - state.threshold);
    var remainingTotal = scores.reduce(function (total, score, index) {
      return index === chosen ? total : total + score;
    }, 0) || 1;

    return scores.map(function (score, index) {
      return index === chosen ? spike : score / remainingTotal * (1 - spike);
    });
  }

  function startMock() {
    setLabels(MOCK_LABELS);
    showMessage('Mock 모드로 실행 중입니다. 모델과 마이크 없이 가짜 확률을 생성합니다.', 'warn');
    setMode('Mock 모드', 'mock');
    setStatus('normal', '정상 감시 중', '가짜 데이터로 감지 흐름을 시험하고 있습니다.');

    handleScores(makeNormalDistribution(state.labels.length));
    state.mockTimer = setInterval(function () {
      var scores = makeNormalDistribution(state.labels.length);
      if (Math.random() < 0.18) scores = addMockSpike(scores);
      handleScores(scores);
    }, MOCK_INTERVAL_MS);
    return Promise.resolve();
  }

  function setControlsRunning(running) {
    dom.startBtn.disabled = running;
    dom.stopBtn.disabled = !running;
    dom.modelUrl.disabled = running;
    dom.mockMode.disabled = running;
  }

  function start() {
    if (state.listening) return;
    setControlsRunning(true);
    ensureAudio();
    state.mock = dom.mockMode.checked;

    (state.mock ? startMock() : startLive()).then(function () {
      state.listening = true;
    }).catch(function () {
      state.listening = false;
      setControlsRunning(false);
      setMode('대기 중', 'idle');
      setStatus('idle', '대기 중', '설정을 확인한 뒤 다시 시작하세요.');
    });
  }

  function stop() {
    if (state.mockTimer) {
      clearInterval(state.mockTimer);
      state.mockTimer = null;
    }
    if (state.recognizer && state.recognizer.isListening && state.recognizer.isListening()) {
      try { state.recognizer.stopListening(); } catch (error) { console.warn('마이크 감지를 중지하지 못했습니다.', error); }
    }

    state.listening = false;
    state.alarmActive = false;
    clearTimeout(state.alarmTimer);
    state.alarmTimer = null;
    stopSiren();
    dom.alertOverlay.classList.add('hidden');
    setControlsRunning(false);
    hideMessage();
    setMode('대기 중', 'idle');
    setStatus('idle', '대기 중', '감지를 중지했습니다.');
  }

  function updateClock() {
    dom.systemClock.textContent = new Date().toLocaleTimeString('ko-KR', { hour12: false });
  }

  dom.startBtn.addEventListener('click', start);
  dom.stopBtn.addEventListener('click', stop);
  dom.clearLog.addEventListener('click', clearLogs);
  dom.muteSiren.addEventListener('change', function () {
    state.muted = dom.muteSiren.checked;
    if (state.muted) stopSiren();
  });
  dom.threshold.addEventListener('input', function () {
    state.threshold = Number(dom.threshold.value) / 100;
    dom.thresholdValue.value = dom.threshold.value + '%';
    dom.thresholdValue.textContent = dom.threshold.value + '%';
  });
  dom.mockMode.addEventListener('change', function () {
    if (dom.mockMode.checked) showMessage('Mock 모드가 켜졌습니다. 감시 시작을 누르면 가짜 데이터로 동작합니다.', 'warn');
    else hideMessage();
  });

  try {
    var savedUrl = localStorage.getItem('rescueSignal.modelUrl');
    if (savedUrl) dom.modelUrl.value = savedUrl;
    dom.modelUrl.addEventListener('change', function () {
      localStorage.setItem('rescueSignal.modelUrl', dom.modelUrl.value.trim());
    });
  } catch (error) {
    /* 브라우저가 저장소 접근을 막아도 앱은 계속 동작한다. */
  }

  updateClock();
  setInterval(updateClock, 1000);
  setStatus('idle', '대기 중', '시작 버튼을 누르면 감지를 시작합니다.');
}());
