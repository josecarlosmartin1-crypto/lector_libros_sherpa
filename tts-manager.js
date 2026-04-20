// tts-manager.js - Gestor de Estabilidad V5.2

class TTSManager {
    constructor() {
        this.models = {
            'es-ES': {
                name: 'Español (ES)',
                onnxUrl: 'https://huggingface.co/csukuangfj/vits-piper-es_ES-sharvard-medium/resolve/main/es_ES-sharvard-medium.onnx',
                tokensUrl: 'https://huggingface.co/csukuangfj/vits-piper-es_ES-sharvard-medium/resolve/main/tokens.txt'
            },
            'en-GB': {
                name: 'Inglés (UK)',
                onnxUrl: 'https://huggingface.co/csukuangfj/vits-piper-en_GB-alan-low/resolve/main/en_GB-alan-low.onnx',
                tokensUrl: 'https://huggingface.co/csukuangfj/vits-piper-en_GB-alan-low/resolve/main/tokens.txt'
            }
        };

        this.worker = null;
        this.audioContext = null;
        this.currentSource = null;
        
        this.isWorkerBooted = false;
        this.isWasmReady = false;
        this.isModelLoaded = false;
        this.currentLang = null;
        
        this._pendingSpeak = null;
        this._pregeneratedAudios = new Map();
        this._messageQueue = [];
        this._requestIdCounter = 0;

        this.initWorker();
    }

    initWorker() {
        if (this.worker) this.worker.terminate();
        this.worker = new Worker('./tts-worker.js?v=' + Date.now());
        
        this.worker.onmessage = (e) => {
            const { type, samples, sampleRate, text, lang, message, progress, requestId } = e.data;

            switch (type) {
                case 'worker_started':
                    this.isWorkerBooted = true;
                    break;
                case 'wasm_ready':
                    this.isWasmReady = true;
                    this.processQueue();
                    break;
                case 'download_progress':
                    this.updateProgressUI(progress);
                    break;
                case 'model_loaded':
                    this.isModelLoaded = true;
                    this.updateStatusBadge(lang);
                    break;
                case 'generate_done':
                    this.handleWorkerAudio(samples, sampleRate, text, requestId);
                    break;
                case 'error':
                    console.error("TTS Error:", message);
                    this.handleError(message);
                    break;
            }
        };
    }

    updateProgressUI(percent) {
        const statusBadge = document.getElementById('tts-status');
        if (statusBadge) {
            statusBadge.style.setProperty('--download-progress', `${percent}%`);
            statusBadge.innerHTML = `<span class="spinner"></span> Cargando... ${percent}%`;
            statusBadge.classList.add('loading');
        }
    }

    updateStatusBadge(lang) {
        const statusBadge = document.getElementById('tts-status');
        if (statusBadge) {
            statusBadge.classList.remove('loading');
            statusBadge.style.setProperty('--download-progress', `100%`);
            statusBadge.innerHTML = `<span style="color:#22c55e;">●</span> Listo (${lang})`;
            statusBadge.classList.add('ready');
        }
    }

    handleError(msg) {
        const statusBadge = document.getElementById('tts-status');
        if (statusBadge) {
            statusBadge.innerHTML = `<span style="color:#ef4444;">●</span> Error Voz`;
            statusBadge.classList.remove('loading');
        }
    }

    processQueue() {
        while (this._messageQueue.length > 0) {
            this.worker.postMessage(this._messageQueue.shift());
        }
    }

    async loadModel(lang) {
        if (this.isModelLoaded && this.currentLang === lang) return true;
        this.currentLang = lang;
        this.isModelLoaded = false;
        
        const modelInfo = this.models[lang];
        if (!modelInfo) return false;

        const msg = {
            type: 'load_model',
            data: { lang, onnxUrl: modelInfo.onnxUrl, tokensUrl: modelInfo.tokensUrl }
        };

        if (this.isWasmReady) {
            this.worker.postMessage(msg);
        } else {
            this._messageQueue.push(msg);
        }
        return true;
    }

    handleWorkerAudio(samples, sampleRate, text, requestId) {
        if (!this.audioContext) this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const buffer = this.audioContext.createBuffer(1, samples.length, sampleRate);
        buffer.getChannelData(0).set(samples);

        // Si este audio es el que estamos esperando para sonar YA
        if (this._pendingSpeak && this._pendingSpeak.requestId === requestId) {
            const callback = this._pendingSpeak.onEnd;
            this._pendingSpeak = null;
            this.playBuffer(buffer, callback);
        } else {
            // Si no, lo guardamos en la recámara (look-ahead)
            this._pregeneratedAudios.set(text, buffer);
        }
    }

    async speak(text, rate = 1.0, onEndCallback) {
        if (!this.isModelLoaded) return false;
        this.stop();

        if (this._pregeneratedAudios.has(text)) {
            const buffer = this._pregeneratedAudios.get(text);
            this._pregeneratedAudios.delete(text);
            this.playBuffer(buffer, onEndCallback);
            return true;
        }

        const requestId = ++this._requestIdCounter;
        this._pendingSpeak = { text, onEnd: onEndCallback, requestId };
        this.worker.postMessage({ type: 'generate', data: { text, rate, requestId } });
        return true;
    }

    pregenerate(text, rate = 1.0) {
        if (!this.isModelLoaded || !text || text.length < 2) return;
        if (this._pregeneratedAudios.has(text)) return;
        
        const requestId = ++this._requestIdCounter;
        this.worker.postMessage({ type: 'generate', data: { text, rate, requestId } });
    }

    async playBuffer(buffer, onEndCallback) {
        if (!this.audioContext) this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        if (this.audioContext.state === 'suspended') await this.audioContext.resume();
        
        const source = this.audioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(this.audioContext.destination);
        
        this.currentSource = source;
        source.onended = () => {
            if (this.currentSource === source) {
                this.currentSource = null;
                if (onEndCallback) onEndCallback();
            }
        };
        source.start();
    }

    stop() {
        this._pendingSpeak = null;
        if (this.currentSource) {
            try { this.currentSource.stop(); } catch(e) {}
            this.currentSource = null;
        }
    }
}

window.ttsManager = new TTSManager();
