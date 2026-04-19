// main.js - Lógica Lector EPUB y TTS

// ESTADO GLOBAL
let book = null;
let rendition = null;
let currCfi = null;
let tituloGuardado = "";
let isReading = false;
let currentUtterance = null;
let ttsRate = 1.0;
let ttsLang = "es-ES";
let currentTheme = "light";
let wakeLock = null;
let sleepTimerId = null;
let sleepTimerSeconds = 0;

// REFERENCIAS DEL DOM
const PANTALLAS = {
    inicio: document.getElementById('pantalla-inicio'),
    lector: document.getElementById('pantalla-lector')
};

const UI = {
    fileInput: document.getElementById('file-input'),
    btnElegir: document.getElementById('btn-elegir-libro'),
    reanudarContenedor: document.getElementById('reanudar-contenedor'),
    btnReanudar: document.getElementById('btn-reanudar'),
    nombreLibro: document.getElementById('nombre-libro-guardado'),
    
    viewer: document.getElementById('viewer'),
    btnVolver: document.getElementById('btn-volver'),
    tituloLibro: document.getElementById('titulo-libro'),
    progresoPagina: document.getElementById('progreso-pagina'),
    
    btnPrev: document.getElementById('btn-prev'),
    btnNext: document.getElementById('btn-next'),
    
    bookSlider: document.getElementById('book-slider'),
    btnPlay: document.getElementById('btn-play'),
    
    btnSettings: document.getElementById('btn-settings'),
    panelSettings: document.getElementById('panel-settings'),
    rangoVelocidad: document.getElementById('rango-velocidad'),
    valorVelocidad: document.getElementById('valor-velocidad'),
    selectIdioma: document.getElementById('select-idioma'),
    selectTema: document.getElementById('select-tema'),
    selectTimer: document.getElementById('select-timer'),
    timerDisplay: document.getElementById('timer-display')
};

// INICIALIZACIÓN
async function init() {
    // Restaurar preferencias Guardadas
    ttsRate = parseFloat(localStorage.getItem('ttsRate') || '1.0');
    ttsLang = localStorage.getItem('ttsLang') || 'es-ES';
    currentTheme = localStorage.getItem('readerTheme') || 'light';
    
    UI.rangoVelocidad.value = ttsRate;
    UI.valorVelocidad.innerText = ttsRate.toFixed(1) + 'x';
    UI.selectIdioma.value = ttsLang;
    UI.selectTema.value = currentTheme;
    
    aplicarTema(currentTheme);
    
    // Inicializar Motor WASM
    window.ttsManager.loadModel(ttsLang);

    // Chequear si hay un libro guardado
    const savedBlob = await localforage.getItem('epubBlob');
    const savedTitle = await localforage.getItem('epubTitle');
    
    if (savedBlob) {
        UI.reanudarContenedor.classList.remove('hidden');
        // Si no hay título guardado, ponemos un genérico
        const displayTitle = savedTitle || "el libro anterior";
        UI.nombreLibro.innerText = displayTitle;
        tituloGuardado = displayTitle;
    }

    eventListeners();
}

function eventListeners() {
    // Pantalla Inicial
    UI.btnElegir.addEventListener('click', () => UI.fileInput.click());
    
    UI.fileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        // Guardar blob offline
        await localforage.setItem('epubBlob', file);
        await localforage.setItem('epubTitle', file.name);
        // Borrar CFI guardado porque es un libro nuevo
        localStorage.removeItem('currentCFI');
        
        // Actualizar el botón "Reanudar" inmediatamente para esta sesión
        tituloGuardado = file.name;
        UI.nombreLibro.innerText = file.name;
        UI.reanudarContenedor.classList.remove('hidden');
        
        cargarLibro(file, file.name);
    });

    UI.btnReanudar.addEventListener('click', async () => {
        const savedBlob = await localforage.getItem('epubBlob');
        if (savedBlob) {
            cargarLibro(savedBlob, tituloGuardado);
        }
    });

    // Controles Lector
    UI.btnVolver.addEventListener('click', () => {
        stopTts();
        if (book) {
            book.destroy();
            book = null;
            rendition = null;
        }
        mostrarPantalla('inicio');
    });

    UI.btnPrev.addEventListener('click', prevPage);
    UI.btnNext.addEventListener('click', nextPage);

    // SLIDER DE PROGRESO DE LIBRO COMPLETO
    // 1. Efecto en vivo mientras se arrastra (Previsualización de página destino)
    UI.bookSlider.addEventListener('input', (e) => {
        if (!book || !book.locations || book.locations.length() === 0) return;
        const percent = parseFloat(e.target.value) / 100;
        const totalPages = book.locations.length();
        const targetPage = Math.ceil(percent * totalPages) || 1;
        UI.progresoPagina.innerText = `Pag ${targetPage} de ${totalPages}`;
    });

    // 2. Efecto definitivo al soltar el dedo (Salto en el libro)
    UI.bookSlider.addEventListener('change', (e) => {
        if (!book || !book.locations) return;
        const percent = parseFloat(e.target.value) / 100;
        const cfi = book.locations.cfiFromPercentage(percent);
        if (cfi) {
            stopTts();
            currentParagraphs = [];
            currentPIndex = -1;
            rendition.display(cfi);
        }
    });

    UI.btnSettings.addEventListener('click', () => {
        UI.panelSettings.classList.toggle('hidden');
    });

    // Ajustes
    UI.rangoVelocidad.addEventListener('input', (e) => {
        ttsRate = parseFloat(e.target.value);
        UI.valorVelocidad.innerText = ttsRate.toFixed(1) + 'x';
        localStorage.setItem('ttsRate', ttsRate);
    });

    UI.selectIdioma.addEventListener('change', (e) => {
        ttsLang = e.target.value;
        localStorage.setItem('ttsLang', ttsLang);
        window.ttsManager.loadModel(ttsLang);
        if(isReading) { stopTts(); startTts(); }
    });

    UI.selectTema.addEventListener('change', (e) => {
        aplicarTema(e.target.value);
    });

    UI.selectTimer.addEventListener('change', (e) => {
        const minutos = parseInt(e.target.value);
        configurarTemporizador(minutos);
    });

    // Play TTS
    UI.btnPlay.addEventListener('click', toggleTts);
}

// GESTIÓN DE REPOSO (WAKE LOCK)
async function solicitarWakeLock() {
    if ('wakeLock' in navigator) {
        try {
            wakeLock = await navigator.wakeLock.request('screen');
            console.log('Wake Lock activo');
        } catch (err) {
            console.error('Error al solicitar Wake Lock:', err);
        }
    }
}

function liberarWakeLock() {
    if (wakeLock) {
        wakeLock.release().then(() => {
            wakeLock = null;
            console.log('Wake Lock liberado');
        });
    }
}

// Re-solicitar si vuelve la visibilidad
document.addEventListener('visibilitychange', async () => {
    if (wakeLock !== null && document.visibilityState === 'visible') {
        await solicitarWakeLock();
    }
});

// TEMPORIZADOR DE APAGADO
function configurarTemporizador(minutos) {
    // Limpiar anterior
    if (sleepTimerId) clearInterval(sleepTimerId);
    
    if (minutos === 0) {
        sleepTimerSeconds = 0;
        UI.timerDisplay.classList.add('hidden');
        return;
    }

    sleepTimerSeconds = minutos * 60;
    UI.timerDisplay.innerText = formatearTiempo(sleepTimerSeconds);
    UI.timerDisplay.classList.remove('hidden');

    sleepTimerId = setInterval(() => {
        sleepTimerSeconds--;
        if (sleepTimerSeconds <= 0) {
            clearInterval(sleepTimerId);
            sleepTimerId = null;
            UI.timerDisplay.classList.add('hidden');
            UI.selectTimer.value = "0";
            if (isReading) stopTts();
        } else {
            UI.timerDisplay.innerText = formatearTiempo(sleepTimerSeconds);
        }
    }, 1000);
}

function formatearTiempo(segundos) {
    const min = Math.floor(segundos / 60);
    const seg = segundos % 60;
    return `${min}:${seg.toString().padStart(2, '0')}`;
}

function aplicarTema(tema) {
    currentTheme = tema;
    localStorage.setItem('readerTheme', tema);
    
    // Limpiar clases previas
    document.body.classList.remove('theme-light', 'theme-sepia', 'theme-dark');
    document.body.classList.add(`theme-${tema}`);
    
    // Si el libro está cargado, actualizar el estilo dentro del iframe
    if (rendition) {
        rendition.themes.select(tema);
    }
}

// LOGICA EPUB.JS
let currentParagraphs = [];
let currentPIndex = -1;
let currentHighlight = null;

function cargarLibro(bookData, titulo) {
    mostrarPantalla('lector');
    UI.tituloLibro.innerText = titulo;
    UI.viewer.innerHTML = ''; // Limpiar div

    // Inicializar libro
    book = ePub(bookData);

    // Registrar Temas en Epub.js
    book.ready.then(() => {
        rendition.themes.register("light", { 
            "body": { "background": "#ffffff", "color": "#111111" },
            "p": { "color": "#111111" }
        });
        rendition.themes.register("sepia", { 
            "body": { "background": "#f4ecd8", "color": "#5b4636" },
            "p": { "color": "#5b4636" }
        });
        rendition.themes.register("dark", { 
            "body": { "background": "#1a1a1a", "color": "#e2e8f0" },
            "p": { "color": "#e2e8f0" }
        });
        rendition.themes.select(currentTheme);
    });

    // Obtener metadatos reales para actualizar el título
    book.loaded.metadata.then(meta => {
        if (meta.title) {
            const cleanTitle = meta.title.trim();
            UI.tituloLibro.innerText = cleanTitle;
            UI.nombreLibro.innerText = cleanTitle;
            tituloGuardado = cleanTitle;
            localforage.setItem('epubTitle', cleanTitle);
        }
    }).catch(err => console.error("Error cargando metadatos:", err));
    
    // Renderización adaptada a scroll continuo
    rendition = book.renderTo("viewer", {
        width: "100%",
        height: "100%",
        spread: "none",
        manager: "default",
        flow: "scrolled-doc" 
    });

    // Generar paginación base
    book.ready.then(() => {
        return book.locations.generate(1600); 
    }).then(() => {
        actualizarProgresoUI();
    });

    const savedCFI = localStorage.getItem('currentCFI');
    if (savedCFI) {
        rendition.display(savedCFI);
    } else {
        rendition.display();
    }

    // Usamos el hook nativo de epubjs que se dispara exactamente 1 vez por cada marco (iframe) que monta 
    rendition.hooks.content.register((contents) => {
        const doc = contents.document;
        // Solo elementos que contienen texto y NO anidan otro bloque idéntico para evitar lectura doble (Ej: li con un p dentro)
        const blocks = Array.from(doc.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li'));
        
        blocks.forEach((p) => {
            // Filtro protector: si este bloque contiene otro bloque válido por debajo, lo ignoramos para leer solo el más interno.
            if(!p.querySelector('p, h1, h2, h3, h4, h5, h6, li')) {
                p.style.cursor = "pointer";
                // Limpiar urls web sueltas si en la epub solo era spam de texto (opcional si es muy molesto)
                
                p.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (isReading) stopTts();
                    
                    // Cuando tocamos un texto, capturamos todo el DOM de ESE iframe en particular para que la lectura sea lineal
                    currentParagraphs = Array.from(doc.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li')).filter(el => !el.querySelector('p, h1, h2, h3, h4, h5, h6, li'));
                    currentPIndex = currentParagraphs.indexOf(p);
                    
                    if(currentPIndex !== -1) {
                        setTimeout(() => startTts(), 100);
                    }
                });
            }
        });
    });

    // Guardar posición al moverse (scroll manual libre)
    rendition.on('relocated', (location) => {
        if(!isReading) { 
            currCfi = location.start.cfi;
            localStorage.setItem('currentCFI', currCfi);
            actualizarProgresoUI();
        }
    });
}

function prevPage() {
    stopTts();
    currentParagraphs = [];
    currentPIndex = -1;
    
    if (!rendition) return;

    // Obtener capítulo actual para forzar salto a cabecera del previo
    const loc = rendition.currentLocation();
    if(loc && loc.start && typeof loc.start.index !== 'undefined') {
        const idx = loc.start.index;
        if(idx > 0) {
            try {
                const prevItem = book.spine.get(idx - 1);
                if(prevItem && prevItem.href) {
                    rendition.display(prevItem.href);
                    return; // Retorno de éxito
                }
            } catch(e) { console.warn("Fallo ubicando cabecera previa", e); }
        }
    }
    
    // Paracaídas de emergencia si todo falla
    rendition.prev();
}

function nextPage() {
    stopTts();
    currentParagraphs = [];
    currentPIndex = -1;
    if (rendition) rendition.next();
}

function actualizarProgresoUI() {
    if (!book || !book.locations || book.locations.length() === 0) return;
    if (!currCfi) return;

    let percentage = book.locations.percentageFromCfi(currCfi);
    if(percentage < 0) percentage = 0;
    if(percentage > 1) percentage = 1;

    const totalPages = book.locations.length();
    const currentPage = Math.ceil(percentage * totalPages) || 1;

    UI.progresoPagina.innerText = `Pag ${currentPage} de ${totalPages}`;
    
    // Sync slider value without triggering change event loop
    if (UI.bookSlider) {
        UI.bookSlider.value = (percentage * 100).toFixed(2);
    }
}

// LOGICA TEXT-TO-SPEECH
function toggleTts() {
    if (isReading) {
        stopTts();
    } else {
        // Verificar si el motor está listo antes de empezar
        if (!window.ttsManager.isModelLoaded) {
            alert("La voz aún no está lista. Por favor, espera a que termine de cargar.");
            return;
        }
        startTts();
    }
}

function stopTts() {
    isReading = false;
    window.ttsManager.stop();
    UI.btnPlay.innerHTML = "▶️";
    UI.btnPlay.classList.remove('reading');
    
    liberarWakeLock();

    // Quitar resaltado activo
    if (currentHighlight) {
        currentHighlight.style.backgroundColor = "transparent";
        currentHighlight = null;
    }
}

async function startTts() {
    window.ttsManager.stop();
    
    // Si dimos a play y la memoria está vacía, calculamos de qué iframe debemos sacar el texto
    if (currentPIndex === -1 || currentParagraphs.length === 0) {
        if(!rendition) return;
        const activeContents = rendition.getContents();
        if(activeContents && activeContents.length > 0) {
            const doc = activeContents[0].document; // Obtenemos el iframe en pantalla
            currentParagraphs = Array.from(doc.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li'))
                .filter(el => !el.querySelector('p, h1, h2, h3, h4, h5, h6, li')); // Doble protección nidos
            
            // Asignar bloque 0 para evitar fallos si scrollearon por encima
            currentPIndex = 0;
        }
    }

    if (!currentParagraphs || currentParagraphs.length === 0) return; // Seguimos sin datos visuales, aborta

    if (!window.ttsManager.isModelLoaded) {
        alert("Cargando motor de voz... Espera un momento.");
        return;
    }

    isReading = true;
    UI.btnPlay.innerHTML = "⏸️";
    UI.btnPlay.classList.add('reading');
    
    await solicitarWakeLock();
    
    setTimeout(() => readNextParagraph(), 50);
}

function readNextParagraph() {
    if (!isReading) return;
    
    if (currentPIndex >= currentParagraphs.length) {
        // Reseteo extremo de variables locales para prevenir carreras (Jump de múltiples capítulos)
        let isAutoReading = isReading;
        stopTts(); 
        currentParagraphs = [];
        currentPIndex = -1;
        
        rendition.next().then(() => {
            setTimeout(() => { 
                if (isAutoReading) {
                    startTts(); // Iniciar calculará el activeContents desde 0 de forma segura
                }
            }, 1000); 
        });
        return;
    }
    
    const p = currentParagraphs[currentPIndex];
    if (!p) {
        currentPIndex++;
        setTimeout(() => readNextParagraph(), 10);
        return;
    }

    // Exclusión de hipervínculos web basura muy pesados o vacíos inútiles
    let text = p.innerText.trim();
    if (text.startsWith("www.") || text.startsWith("http")) { // Ignorar encriptado basurilla
        text = "";
    }

    if (text.length < 2) { 
        currentPIndex++;
        setTimeout(() => readNextParagraph(), 10);
        return;
    }
    
    // Resaltado Visual
    if (currentHighlight) currentHighlight.style.backgroundColor = "transparent";
    p.style.backgroundColor = "rgba(234, 179, 8, 0.4)";
    currentHighlight = p;
    p.scrollIntoView({ behavior: 'smooth', block: 'center' });
    
    // Actualizar Memoria
    try {
        const contents = rendition.getContents()[0];
        if (contents) {
            const pCfi = contents.cfiFromNode(p);
            if (pCfi) {
                currCfi = pCfi;
                localStorage.setItem('currentCFI', currCfi);
                actualizarProgresoUI();
            }
        }
    } catch(e) {}
    
    // Locución Offline con look-ahead
    const speakSuccess = window.ttsManager.speak(text, ttsRate, () => {
        if(isReading) {
            currentPIndex++;
            readNextParagraph();
        }
    });

    // Si el motor falla, detenemos la lectura
    if (speakSuccess === false) {
        console.warn("Fallo al iniciar locución, deteniendo lectura.");
        stopTts();
        return;
    }

    // Look-ahead: pre-generar el SIGUIENTE párrafo mientras éste suena
    // El timeout de 150ms da tiempo a que el audio empiece y el hilo esté libre
    setTimeout(() => {
        if (!isReading) return;
        let nextIdx = currentPIndex + 1;
        // Buscar el siguiente párrafo válido (saltar los vacíos)
        while (nextIdx < currentParagraphs.length) {
            const nextEl = currentParagraphs[nextIdx];
            if (nextEl) {
                const nextText = nextEl.innerText.trim();
                if (nextText.length >= 2 && !nextText.startsWith("www.") && !nextText.startsWith("http")) {
                    window.ttsManager.pregenerate(nextText, ttsRate);
                    break;
                }
            }
            nextIdx++;
        }
    }, 150);
}

// Utilidades UI
function mostrarPantalla(id) {
    Object.values(PANTALLAS).forEach(p => {
        p.classList.add('hidden');
        p.classList.remove('activa');
    });
    PANTALLAS[id].classList.remove('hidden');
    setTimeout(() => {
        PANTALLAS[id].classList.add('activa');
    }, 50);
}

// Iniciar aplicación
document.addEventListener('DOMContentLoaded', init);
