// tts-manager.js - Gestor Inteligente V5

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
        
        this.isWorkerBooted = false; // El script del worker ha arrancado
        this.isWasmReady = false;    // El motor WASM está listo
        this.isModelLoaded = false;
        this.currentLang = null;
        
        this._pendingSpeak = null;
        this._pregeneratedAudios = new Map();
        this._messageQueue = []; // Cola de mensajes mientras carga el worker

        this.initWorker();
    }

    initWorker() {
        if (this.worker) {
            this.worker.terminate();
        }

        console.log("TTS Manager: Inicializando Web Worker...");
        this.worker = new Worker('./tts-worker.js?v=' + Date.now());
        
        this.worker.onmessage = (e) => {
            const { type, samples, sampleRate, text, lang, message } = e.data;

            switch (type) {
                case 'worker_started':
                    console.log("TTS Manager: Worker ha arrancado.");
                    this.isWorkerBooted = true;
                    break;
                case 'wasm_ready':
                    console.log("TTS Manager: WASM listo en el Worker.");
                    this.isWasmReady = true;
                    this.processQueue();
                    break;
                case 'model_loaded':
                    console.log(`TTS Manager: Modelo ${lang} cargado.`);
                    this.isModelLoaded = true;
                    this.updateStatusBadge(lang);
                    break;
                case 'generate_done':
                    this.handleWorkerAudio(samples, sampleRate, text);
                    break;
                case 'error':
                    console.error("TTS Manager Error de Worker:", message);
                    this.handleError(message);
                    break;
            }
        };

        this.worker.onerror = (err) => {
            console.error("TTS Manager: Fallo crítico de Worker:", err);
            this.handleError("Fallo de arranque del Worker");
        };
    }

    processQueue() {
        console.log(`TTS Manager: Procesando cola de espera (${this._messageQueue.length} mensajes)...`);
        while (this._messageQueue.length > 0) {
            const msg = this._messageQueue.shift();
            this.worker.postMessage(msg);
        }
    }

    handleError(msg) {
        const statusBadge = document.getElementById('tts-status');
        if (statusBadge) {
            statusBadge.innerHTML = `<span style="color:#ef4444;">●</span> Error: ${msg.substring(0, 15)}...`;
        }
    }

    updateStatusBadge(lang) {
        const statusBadge = document.getElementById('tts-status');
        if (statusBadge) {
            statusBadge.innerHTML = `<span style="color:#22c55e;">●</span> Listo (${lang})`;
            statusBadge.classList.add('ready');
        }
    }

    async loadModel(lang) {
        if (this.isModelLoaded && this.currentLang === lang) return true;
        
        this.currentLang = lang;
        this.isModelLoaded = false;
        
        const modelInfo = this.models[lang];
        if (!modelInfo) return false;

        const statusBadge = document.getElementById('tts-status');
        if (statusBadge) statusBadge.innerText = 'Cargando Voz...';

        const msg = {
            type: 'load_model',
            data: {
                lang,
                onnxUrl: modelInfo.onnxUrl,
                tokensUrl: modelInfo.tokensUrl
            }
        };

        if (this.isWasmReady) {
            this.worker.postMessage(msg);
        } else {
            console.log("TTS Manager: WASM no listo, encolando carga de modelo...");
            this._messageQueue.push(msg);
        }
        
        return true;
    }

    handleWorkerAudio(samples, sampleRate, text) {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }

        const buffer = this.audioContext.createBuffer(1, samples.length, sampleRate);
        buffer.getChannelData(0).set(samples);

        if (this._pendingSpeak && this._pendingSpeak.text === text) {
            const callback = this._pendingSpeak.onEnd;
            this._pendingSpeak = null;
            this.playBuffer(buffer, callback);
        } else {
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

        this._pendingSpeak = { text, onEnd: onEndCallback };
        this.worker.postMessage({
            type: 'generate',
            data: { text, rate }
        });
        return true;
    }

    pregenerate(text, rate = 1.0) {
        if (!this.isModelLoaded || !text || text.length < 2) return;
        if (this._pregeneratedAudios.has(text)) return;

        this.worker.postMessage({
            type: 'generate',
            data: { text, rate }
        });
    }

    async playBuffer(buffer, onEndCallback) {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }

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
