// tts-manager.js
// Gestor de TTS Offline basado en Sherpa-ONNX WASM (Estabilizado)

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

        this.engine = null;
        this.Module = null;
        this.audioContext = null;
        this.currentSource = null;
        
        // Look-ahead: buffer del siguiente párrafo pre-generado
        this._pregeneratedBuffer = null;
        this._pregeneratedText = null;
        
        this.isWasmInitialized = false;
        this.isModelLoaded = false;
        this.isInitializing = false;
        this.currentLang = null;
        
        // Rutas locales del motor (descargadas para evitar errores CORS)
        this.wasmJsUrl = './sherpa-onnx-wasm-main-tts.js';
        this.wasmHelperUrl = './sherpa-onnx-tts.js';
        this.wasmWasmUrl = './sherpa-onnx-wasm-main-tts.wasm';
    }

    // 1. Inicialización robusta del motor core
    async initWasm() {
        if (this.isWasmInitialized) return true;
        if (this.isInitializing) {
            // Esperar a que la inicialización en curso termine
            while (this.isInitializing) {
                await new Promise(r => setTimeout(r, 100));
            }
            return this.isWasmInitialized;
        }

        this.isInitializing = true;
        const statusBadge = document.getElementById('tts-status');
        if (statusBadge) statusBadge.innerText = "Iniciando motor...";

        console.log("TTS: Iniciando carga de binarios WASM...");

        try {
            // Definir Module ANTES de cargar scripts
            return await new Promise((resolve, reject) => {
                window.Module = {
                    locateFile: (path) => {
                        if (path.endsWith('.wasm')) return this.wasmWasmUrl;
                        if (path.endsWith('.data')) return 'https://huggingface.co/spaces/k2-fsa/web-assembly-tts-sherpa-onnx-en/resolve/main/sherpa-onnx-wasm-main-tts.data';
                        return path;
                    },
                    print: (t) => console.log("Sherpa-ONNX:", t),
                    printErr: (t) => console.error("Sherpa-ONNX Error:", t),
                    onRuntimeInitialized: () => {
                        console.log("TTS: Runtime WASM cargado correctamente");
                        this.Module = window.Module;
                        this.isWasmInitialized = true;
                        this.isInitializing = false;
                        resolve(true);
                    }
                };

                // Cargar scripts secuencialmente
                this.loadExternalScript(this.wasmJsUrl)
                    .then(() => this.loadExternalScript(this.wasmHelperUrl))
                    .catch(e => {
                        this.isInitializing = false;
                        reject(e);
                    });

                // Timeout de seguridad por si el WASM no carga (60s)
                setTimeout(() => {
                    if (!this.isWasmInitialized) {
                        this.isInitializing = false;
                        reject(new Error("Timeout cargando WASM"));
                    }
                }, 60000);
            });
        } catch (error) {
            console.error("TTS: Fallo crítico inicializando core:", error);
            this.isInitializing = false;
            if (statusBadge) statusBadge.innerText = "Error Motor";
            return false;
        }
    }

    // 2. Carga coordinada de voz e idioma
    async loadModel(lang) {
        if (this.isModelLoaded && this.currentLang === lang) return true;
        
        console.log(`TTS: Cargando modelo para el idioma: ${lang}`);
        this.currentLang = lang;
        this.isModelLoaded = false;
        
        const statusBadge = document.getElementById('tts-status');
        const downloadContainer = document.getElementById('progress-download-container');
        
        try {
            const coreReady = await this.initWasm();
            if (!coreReady) return false;

            const modelInfo = this.models[lang];
            if (!modelInfo) throw new Error(`Idioma ${lang} no soportado`);

            if (statusBadge) statusBadge.innerText = 'Cargando Voz...';

            // Descarga de archivos (vía caché o red)
            const onnxBuffer = await this.fetchAndCache(modelInfo.onnxUrl, 'onnx');
            const tokensBuffer = await this.fetchAndCache(modelInfo.tokensUrl, 'tokens');

            // Preparar FS de Emscripten (Referencia robusta al sistema de archivos virtual)
            let emFS = window.FS || (this.Module ? this.Module.FS : null);
            if (!emFS) {
                console.log("TTS: Esperando inicialización de FS...");
                await new Promise(r => setTimeout(r, 800)); // Espera generosa para carga de .data
                emFS = window.FS || (this.Module ? this.Module.FS : null);
            }

            if (!emFS) throw new Error("Fallo crítico: No se encontró el objeto FS de Emscripten");

            const onnxFile = `model_${lang}.onnx`;
            const tokensFile = `tokens_${lang}.txt`;
            
            console.log("TTS: Escribiendo archivos en el sistema virtual...");
            emFS.writeFile(onnxFile, new Uint8Array(onnxBuffer));
            emFS.writeFile(tokensFile, new Uint8Array(tokensBuffer));

            const ttsConfig = {
                offlineTtsModelConfig: {
                    offlineTtsVitsModelConfig: {
                        model: onnxFile,
                        tokens: tokensFile,
                        lexicon: '', 
                        dataDir: 'espeak-ng-data', 
                        noiseScale: 0.667,
                        noiseScaleW: 0.8,
                        lengthScale: 1.0
                    },
                    numThreads: 1,
                    debug: 0,
                    provider: 'cpu'
                },
                ruleFsts: '',
                ruleFars: '',
                maxNumSentences: 1
            };

            if (typeof createOfflineTts !== 'function') {
                throw new Error("Librería helper de Sherpa-ONNX no encontrada");
            }

            this.engine = createOfflineTts(this.Module, ttsConfig);
            this.isModelLoaded = true;

            if (statusBadge) {
                statusBadge.innerHTML = `<span style="color:#22c55e;">●</span> Local (${lang})`;
                statusBadge.classList.add('ready');
            }
            console.log(`TTS: Motor listo para el idioma ${lang}`);
            return true;

        } catch (error) {
            console.error("TTS: Error cargando modelo:", error);
            if (statusBadge) statusBadge.innerText = 'Error de Voz';
            return false;
        } finally {
            if (downloadContainer) downloadContainer.classList.add('hidden');
        }
    }

    // 3. Sistema de red y caché eficiente
    async fetchAndCache(url, type) {
        // Clave única: incluye nombre del repo para evitar colisión entre idiomas
        // (tokens.txt de ES y EN tienen el mismo nombre de archivo)
        const urlParts = url.split('/');
        const repoName = urlParts[urlParts.length - 4] || 'unknown';
        const fileName = urlParts[urlParts.length - 1];
        const fileID = (repoName + '_' + fileName).replace(/[.-]/g, '_');
        const cacheKey = `tts_v4_${fileID}`; // v4 invalida entradas corruptas anteriores
        let data = await localforage.getItem(cacheKey);

        if (!data) {
            console.log(`TTS: Asset no encontrado en caché, descargando...`);
            data = await this.downloadWithProgress(url, type === 'onnx');
            if (data) await localforage.setItem(cacheKey, data);
        }
        return data;
    }

    downloadWithProgress(url, useProgressBar) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', url, true);
            xhr.responseType = 'arraybuffer';

            const container = document.getElementById('progress-download-container');
            const bar = document.getElementById('progress-download-bar');

            if (useProgressBar && container) container.classList.remove('hidden');

            xhr.onprogress = (e) => {
                if (e.lengthComputable && bar && useProgressBar) {
                    const pct = (e.loaded / e.total) * 100;
                    bar.style.width = pct + '%';
                }
            };

            xhr.onload = () => {
                if (xhr.status === 200) resolve(xhr.response);
                else reject(new Error(`Fallo descarga Sherpa: ${xhr.status}`));
            };
            xhr.onerror = () => reject(new Error("Error de red durante la descarga del modelo"));
            xhr.send();
        });
    }

    loadExternalScript(url) {
        return new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = url;
            s.async = true;
            s.onload = resolve;
            s.onerror = (e) => {
                console.error(`Error cargando el script externo: ${url}`);
                reject(e);
            };
            document.head.appendChild(s);
        });
    }

    // 4. Locución segura con look-ahead (Evita el bucle de "scroll loco")
    async speak(text, rate = 1.0, onEndCallback) {
        if (!this.engine || !this.isModelLoaded) {
            console.warn("TTS: Intento de speak sin motor cargado. Abortando flujos.");
            return false;
        }

        // Recuperar contexto si es necesario
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }

        this.stop();

        try {
            let buffer;

            // Usar buffer pre-generado si coincide con el texto solicitado
            if (this._pregeneratedBuffer && this._pregeneratedText === text) {
                buffer = this._pregeneratedBuffer;
                this._pregeneratedBuffer = null;
                this._pregeneratedText = null;
                console.log("TTS: Usando buffer pre-generado (óptimo).");
            } else {
                // Generación normal (sin look-ahead disponible)
                this._pregeneratedBuffer = null;
                this._pregeneratedText = null;
                const audioObj = this.engine.generate({ text, sid: 0, speed: rate });
                if (!audioObj || !audioObj.samples || audioObj.samples.length === 0) {
                    console.warn("TTS: La síntesis no ha devuelto muestras de audio.");
                    return false;
                }
                buffer = this.audioContext.createBuffer(1, audioObj.samples.length, audioObj.sampleRate);
                buffer.getChannelData(0).set(audioObj.samples);
            }

            const source = this.audioContext.createBufferSource();
            source.buffer = buffer;
            source.connect(this.audioContext.destination);
            this.currentSource = source;
            source.onended = () => {
                this.currentSource = null;
                if (onEndCallback) onEndCallback();
            };
            source.start();
            return true;

        } catch (error) {
            console.error("TTS: Error durante la síntesis o reproducción:", error);
            return false;
        }
    }

    // 5. Pre-generación del siguiente párrafo (look-ahead)
    //    Se llama MIENTRAS el párrafo actual suena, para eliminar la pausa entre párrafos.
    pregenerate(text, rate = 1.0) {
        if (!this.engine || !this.isModelLoaded || !text || text.length < 2) return;
        if (this._pregeneratedText === text) return; // Ya está generado

        try {
            this._pregeneratedBuffer = null;
            this._pregeneratedText = null;
            console.log("TTS: Pre-generando siguiente párrafo...");
            const audioObj = this.engine.generate({ text, sid: 0, speed: rate });
            if (audioObj && audioObj.samples && audioObj.samples.length > 0) {
                if (!this.audioContext) {
                    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
                }
                const buffer = this.audioContext.createBuffer(1, audioObj.samples.length, audioObj.sampleRate);
                buffer.getChannelData(0).set(audioObj.samples);
                this._pregeneratedBuffer = buffer;
                this._pregeneratedText = text;
                console.log("TTS: Buffer del siguiente párrafo listo.");
            }
        } catch(e) {
            // Si falla la pre-generación, no es crítico: speak() generará normalmente
            this._pregeneratedBuffer = null;
            this._pregeneratedText = null;
        }
    }

    stop() {
        if (this.currentSource) {
            try { this.currentSource.stop(); } catch(e) {}
            this.currentSource = null;
        }
    }
}

// Exportar instancia única
window.ttsManager = new TTSManager();
