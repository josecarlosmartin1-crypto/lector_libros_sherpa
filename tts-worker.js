// tts-worker.js - Arquitectura Robusta V5.1 (Con Progreso)

self.onerror = function(msg, url, line, col, error) {
    postMessage({ type: 'error', message: `Worker Error: ${msg} en ${line}:${col}` });
    return false;
};

try {
    importScripts('https://cdnjs.cloudflare.com/ajax/libs/localforage/1.10.0/localforage.min.js');

    let Module = null;
    let engine = null;
    let currentLang = null;
    let isWasmLoaded = false;

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

    importScripts('sherpa-onnx-wasm-main-tts.js');
    importScripts('sherpa-onnx-tts.js');
    postMessage({ type: 'worker_started' });

    self.onmessage = async (e) => {
        const { type, data } = e.data;
        switch (type) {
            case 'load_model':
                if (!isWasmLoaded) {
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
            
            // Solo reportamos progreso para el ONNX que es el pesado (~50MB)
            const onnxBuffer = await fetchAndCache(onnxUrl, lang, 'onnx', true);
            const tokensBuffer = await fetchAndCache(tokensUrl, lang, 'tokens', false);

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
        if (!engine) return;
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

    async function fetchAndCache(url, lang, type, reportProgress = false) {
        const urlParts = url.split('/');
        const fileName = urlParts[urlParts.length - 1];
        const cacheKey = `tts_v5_${lang}_${type}_${fileName}`;
        
        let data = await localforage.getItem(cacheKey);
        if (!data) {
            console.log(`Worker: Descargando ${type} para ${lang}...`);
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            
            if (!reportProgress) {
                data = await response.arrayBuffer();
            } else {
                // Lógica de progreso manual con ReadableStream
                const contentLength = response.headers.get('content-length');
                const total = parseInt(contentLength, 10);
                let loaded = 0;
                
                const reader = response.body.getReader();
                const chunks = [];
                
                while(true) {
                    const {done, value} = await reader.read();
                    if (done) break;
                    chunks.push(value);
                    loaded += value.length;
                    
                    if (total) {
                        const progress = Math.round((loaded / total) * 100);
                        postMessage({ type: 'download_progress', progress, lang });
                    }
                }
                
                const combined = new Uint8Array(loaded);
                let pos = 0;
                for (let chunk of chunks) {
                    combined.set(chunk, pos);
                    pos += chunk.length;
                }
                data = combined.buffer;
            }
            
            await localforage.setItem(cacheKey, data);
        } else if (reportProgress) {
            // Si ya estaba en caché, avisar que está al 100% de inmediato
            postMessage({ type: 'download_progress', progress: 100, lang });
        }
        return data;
    }

} catch (globalErr) {
    postMessage({ type: 'error', message: `Critical Worker Boot Error: ${globalErr.message}` });
}
