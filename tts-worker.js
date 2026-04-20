// tts-worker.js - Arquitectura Robusta V5

// 1. Captura de errores temprana
self.onerror = function(msg, url, line, col, error) {
    postMessage({ type: 'error', message: `Worker Error: ${msg} en ${line}:${col}` });
    return false;
};

try {
    // Importar dependencias
    importScripts('https://cdnjs.cloudflare.com/ajax/libs/localforage/1.10.0/localforage.min.js');

    let Module = null;
    let engine = null;
    let currentLang = null;
    let isWasmLoaded = false;

    // Configuración de Emscripten para el Worker
    self.Module = {
        locateFile: (path) => {
            if (path.endsWith('.wasm')) return 'sherpa-onnx-wasm-main-tts.wasm';
            if (path.endsWith('.data')) return 'https://huggingface.co/spaces/k2-fsa/web-assembly-tts-sherpa-onnx-en/resolve/main/sherpa-onnx-wasm-main-tts.data';
            return path;
        },
        print: (t) => console.log("Worker Sherpa:", t),
        printErr: (t) => console.error("Worker Sherpa Error:", t),
        onRuntimeInitialized: () => {
            isWasmLoaded = true;
            postMessage({ type: 'wasm_ready' });
        }
    };

    // Cargar scripts del motor (sin ./ para mayor compatibilidad)
    importScripts('sherpa-onnx-wasm-main-tts.js');
    importScripts('sherpa-onnx-tts.js');

    // Avisar que el Worker ha arrancado al menos
    postMessage({ type: 'worker_started' });

    // Escuchar peticiones del hilo principal
    self.onmessage = async (e) => {
        const { type, data } = e.data;

        switch (type) {
            case 'load_model':
                if (!isWasmLoaded) {
                    // Si el mensaje llega antes que el WASM esté listo, esperar un poco
                    let checkCount = 0;
                    while (!isWasmLoaded && checkCount < 20) {
                        await new Promise(r => setTimeout(r, 500));
                        checkCount++;
                    }
                }
                await handleLoadModel(data);
                break;
            case 'generate':
                handleGenerate(data);
                break;
        }
    };

    async function handleLoadModel({ lang, onnxUrl, tokensUrl }) {
        try {
            currentLang = lang;
            
            // Descarga/Caché
            const onnxBuffer = await fetchAndCache(onnxUrl, lang, 'onnx');
            const tokensBuffer = await fetchAndCache(tokensUrl, lang, 'tokens');

            const onnxFile = `model_${lang}.onnx`;
            const tokensFile = `tokens_${lang}.txt`;
            
            self.FS.writeFile(onnxFile, new Uint8Array(onnxBuffer));
            self.FS.writeFile(tokensFile, new Uint8Array(tokensBuffer));

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

            engine = createOfflineTts(self.Module, ttsConfig);
            postMessage({ type: 'model_loaded', lang });

        } catch (err) {
            postMessage({ type: 'error', message: `LoadModel Error: ${err.message}` });
        }
    }

    function handleGenerate({ text, rate, requestId }) {
        if (!engine) {
            postMessage({ type: 'error', message: "Motor no inicializado para generate" });
            return;
        }
        try {
            const audioObj = engine.generate({ text, sid: 0, speed: rate });
            if (audioObj && audioObj.samples) {
                const samples = audioObj.samples;
                postMessage({ 
                    type: 'generate_done', 
                    samples, 
                    sampleRate: audioObj.sampleRate,
                    requestId,
                    text
                }, [samples.buffer]);
            }
        } catch (err) {
            postMessage({ type: 'error', message: `Generate Error: ${err.message}`, requestId });
        }
    }

    async function fetchAndCache(url, lang, type) {
        const urlParts = url.split('/');
        const fileName = urlParts[urlParts.length - 1];
        const cacheKey = `tts_v5_${lang}_${type}_${fileName}`;
        
        let data = await localforage.getItem(cacheKey);
        if (!data) {
            console.log(`Worker: Descargando ${type} para ${lang}...`);
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status} al descargar ${url}`);
            data = await response.arrayBuffer();
            await localforage.setItem(cacheKey, data);
        }
        return data;
    }

} catch (globalErr) {
    postMessage({ type: 'error', message: `Critical Worker Boot Error: ${globalErr.message}` });
}
