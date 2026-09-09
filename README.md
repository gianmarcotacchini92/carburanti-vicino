# Pieno

App web in italiano per trovare i distributori vicini, confrontare i prezzi
ufficiali MIMIT e calcolare il costo di un rifornimento da **30 litri**.
React + TypeScript, Leaflet/OpenStreetMap, Express, SQLite e Web Push.

## Pubblicazione gratuita: GitHub Pages + Cloudflare

Sito: **https://gianmarcotacchini92.github.io/carburanti-vicino/**  
Backend: https://carburanti-vicino-api.gianmarcotacchini.workers.dev

Questa versione supporta anche una distribuzione senza un server Node acceso:

- **GitHub Pages** ospita il frontend pubblico in `/carburanti-vicino/`.
- **Cloudflare Workers + D1** conservano cache breve e monitoraggi, gestiscono
  geocodifica e sottoscrizioni push. Nessun piano a pagamento viene attivato.
- **GitHub Actions**, nel repository pubblico, esegue un job ogni 30 minuti:
  consulta i prezzi correnti per le zone monitorate, ricontrolla le schede degli
  impianti con possibili anomalie e invia gli avvisi confermati.
  Il telefono e il PC non devono tenere aperta la pagina.

**Dal 9 settembre 2026 la ricerca non usa piu il catalogo CSV giornaliero.**
Il Worker interroga la ricerca geografica del portale MIMIT e conserva le
risposte per **massimo 120 secondi**. Il pulsante "Aggiorna prezzi" forza una
nuova lettura; la pagina ripete la ricerca ogni minuto quando e visibile.
Se la fonte corrente non risponde, viene mostrato un errore: nessun fallback
silenzioso ai prezzi del giorno precedente.

Quando si seleziona un impianto, l'app ne legge la scheda corrente per indirizzo,
singoli prezzi e relative date. Mappa, elenco e costo del pieno vengono aggiornati
insieme; se il prezzo e stato rimosso non viene mantenuto il valore precedente.
Gli endpoint di consultazione usati sono quelli del portale web, non un'API
pubblica con un contratto di stabilita o SLA: eventuali cambiamenti possono
richiedere un adattamento. Le richieste sono limitate e memorizzate brevemente.
Il Worker non esegue crittografia push: gli invii restano nel job Node di Actions.

### Limiti da conoscere

Workers Free include attualmente 100.000 richieste/giorno; D1 Free ha limiti
giornalieri di lettura/scrittura e 500 MB per database. Questa architettura e
pensata per un uso personale o moderato, **non traffico illimitato**.
La disponibilita dipende anche dalle quote e dalle policy dei fornitori:
[Workers](https://developers.cloudflare.com/workers/platform/pricing/),
[D1](https://developers.cloudflare.com/d1/platform/limits/).

I job programmati di GitHub Actions possono essere ritardati o saltati nei
periodi di carico. Nei repository pubblici GitHub puo disattivarli dopo
**60 giorni senza attivita nel repository**: controllare la scheda Actions
e riattivare il workflow se necessario. Non e quindi un servizio con SLA.
Le ricerche dei prezzi non dipendono dagli orari di Actions. Le notifiche, invece,
sono di tipo best-effort, non istantanee. In caso di fonte non disponibile o di
verifica dei prezzi incompleta gli invii vengono sospesi per la zona interessata.

### Gestione del deploy

Il workflow `.github/workflows/pages.yml` pubblica il frontend dopo i push su `main`.
Richiede Pages impostato su **GitHub Actions** e la variabile repository `API_URL`,
con l'origine HTTPS del Worker.
`.github/workflows/monitor.yml` richiede i segreti repository `JOB_TOKEN`,
`VAPID_PUBLIC_KEY` e `VAPID_PRIVATE_KEY`. La chiave privata VAPID non va
inserita nelle variabili `VITE_*`, nel repository o nel frontend.

Il Worker usa `wrangler.jsonc`; il binding `DB` punta all'archivio D1.
Dopo l'accesso con `npx wrangler login`, gli aggiornamenti del backend si applicano con:

```powershell
npx.cmd wrangler d1 migrations apply carburanti-vicino --remote
npm.cmd run worker:deploy
```

Per ripetere la configurazione iniziale privata ed eseguire il monitoraggio:

```powershell
$env:API_URL = "https://URL-DEL-WORKER.workers.dev"
node --import tsx jobs\bootstrap.ts
```

Il bootstrap verifica l'account GitHub, trasferisce i segreti tramite stdin
ai rispettivi secret store e riutilizza le chiavi locali senza stamparle.
Il file SQLite locale e `.wrangler` sono esclusi da Git.
Non cambiare le chiavi VAPID senza considerare le sottoscrizioni gia esistenti.
Non eliminare il database D1 se vuoi conservare i monitoraggi.

L'implementazione Node/SQLite descritta sotto resta disponibile per lo sviluppo
locale o per un server dedicato. Le sottoscrizioni locali non vengono trasferite
automaticamente al sito Pages: dal telefono bisogna attivare gli avvisi sul nuovo sito.

## Avvio su Windows

Richiede **Node.js 24** (usa SQLite integrato).

```powershell
Set-Location C:\Users\Gian\carburanti-vicino
npm.cmd install
npm.cmd run dev
```

Aprire **http://localhost:5173**. Frontend e API partono insieme e interrogano
il portale corrente su richiesta, senza attendere il download dei CSV nazionali.
Durante il caricamento non vengono mostrati prezzi inventati.
Servono una connessione Internet e l'accesso ai servizi esterni.
`npm.cmd` evita il blocco di `npm.ps1` con le policy standard di PowerShell.

Per servire il frontend compilato dalla stessa API:

```powershell
npm.cmd run build
npm.cmd start
```

Aprire **http://localhost:3001**. `npm run preview` serve solo l'anteprima Vite,
non il backend: non usarlo come server dell'app.

## Funzioni

- Ricerca per indirizzo con scelta del risultato, oppure posizione GPS su consenso.
- Mappa e lista sincronizzate, carburante/modalita/raggio fino a 30 km,
  ordinamento per prezzo o distanza in linea d'aria.
- Calcolatore con quantita iniziale di 30 litri e confronto con la mediana locale.
  Il **metano e quotato in EUR/kg**, quindi usa kg e non una conversione fittizia in litri.
- Segnalazione di prezzi insolitamente bassi, con data dell'ultima comunicazione.
- Una zona monitorata per browser, modificabile esplicitamente senza seguire
  continuamente gli spostamenti. Notifiche push anche con la pagina chiusa.
- Archiviazione persistente dei dati, delle sottoscrizioni, delle chiavi VAPID
  e degli avvisi gia inviati in `data/pieno.sqlite`.

## Dati ufficiali e significato delle anomalie

Fonti:

- [MIMIT - Open data carburanti](https://www.mimit.gov.it/it/open-data/elenco-dataset/carburanti-prezzi-praticati-e-anagrafica-degli-impianti)
- [Anagrafica degli impianti](https://www.mimit.gov.it/images/exportCSV/anagrafica_impianti_attivi.csv)
- [Prezzi alle 8](https://www.mimit.gov.it/images/exportCSV/prezzo_alle_8.csv)
- [Osservaprezzi Carburanti](https://carburanti.mise.gov.it/ospzSearch/)

Fonte: **Ministero delle Imprese e del Made in Italy - Osservaprezzi Carburanti**.
I dataset CSV sono distribuiti con licenza [IODL 2.0](https://www.dati.gov.it/content/italian-open-data-license-v20).
Elaborazione indipendente; servizio non ufficiale.

I CSV sono pubblicati quotidianamente e descrivono le informazioni in vigore
**alle 08:00 del giorno precedente alla pubblicazione**, non prezzi in tempo reale.
La data di estrazione nel file identifica lo snapshot, non il download.
Questo era il motivo per cui la prima versione poteva avere prezzi gia superati
sul portale. Il codice di importazione e le vecchie celle sono conservati per
compatibilita, ma **non alimentano piu la ricerca o le notifiche** e non vengono
usati come fallback. Il nuovo percorso legge `/ospzApi/search/zone` e
`/ospzApi/registry/servicearea/{id}` del portale tramite il backend.

La ricerca geografica riporta l'ultima comunicazione dell'impianto, non
necessariamente quella di ciascun prezzo. La UI distingue questa data da
quella specifica della scheda e dall'orario della nostra consultazione.
Non si rinomina lo snapshot di ieri come "oggi" per farlo sembrare aggiornato.

I prezzi sono quelli comunicati dagli esercenti. Coordinate mancanti/non valide
non sono mappabili; carburanti speciali/premium non sono mescolati ai prodotti
standard Benzina, Gasolio, GPL e Metano. Non si deducono apertura o disponibilita.

L'importatore CSV legacy usa `|` dal 10 febbraio 2026; sono gestiti anche i vecchi
CSV con `;`. Alcune righe della fonte contengono delimitatori non protetti:
quelle con numero di colonne incoerente vengono escluse e conteggiate nei log,
senza spostare arbitrariamente i campi. Oltre l'1% di righe malformate o una
riduzione superiore al 20% della copia valida precedente blocca l'importazione.
I timestamp senza fuso vengono interpretati come ora civile `Europe/Rome`,
convenzione dell'app poiche la fonte non dichiara esplicitamente un offset.
Vedi i [metadati ufficiali](https://www.mimit.gov.it/images/stories/documenti/Metadati_prezzi_carburanti_20260128.pdf).

Un prezzo viene segnalato quando e **almeno il 25% sotto la mediana di almeno
5 ALTRI impianti**, nella zona cercata, con lo stesso carburante e la stessa
modalita self/servito. Gli indicatori della mappa sono preliminari: la ricerca
fornisce una data aggregata dell'impianto. Prima di inviare push il job consulta
le schede dei candidati e dei pari per confermare prezzo e data specifici:
il prezzo candidato e quelli di confronto devono essere stati comunicati
negli ultimi 7 giorni. In modalita "tutti" self e servito sono
comunque analizzati separatamente. La mediana riassuntiva della zona, invece,
rappresenta tutti i prezzi recenti dei filtri selezionati.

E una **possibile anomalia**, non la prova di un errore o la promessa che il
prezzo sara applicato. Anche prezzi leciti possono essere segnalati e gli errori
non necessariamente vengono rilevati. Verificare sempre alla pompa. Unita,
data, campione e modalita contano piu del semplice prezzo minimo.

## Notifiche push

Il consenso viene chiesto solo premendo il pulsante di attivazione. La pagina
puo essere chiusa: Actions controlla la zona ogni 30 minuti nella pubblicazione
gratuita; il server locale ogni 15 minuti. Gli avvisi passano tramite il gateway
del browser. Le notifiche
non richiedono che il JavaScript della pagina rimanga aperto.

Condizioni reali di funzionamento:

- Il **server deve restare acceso e collegato a Internet**. Il processo locale
  non lavora quando il PC e spento. Per uso continuativo pubblicare su un server.
- In produzione serve **HTTPS**; `localhost` e ammesso per sviluppo.
- Browser, sistema operativo, risparmio energetico e permessi possono ritardare
  o impedire la consegna. Non e garantita se il browser viene arrestato
  completamente o se le notifiche sono disabilitate nel sistema.
- Su iOS/iPadOS 16.4+ usare Safari e aggiungere l'app alla schermata Home.
- Il canale supporta i gateway standard di Chrome/Edge, Firefox, Safari e Windows.

Le chiavi VAPID vengono generate una sola volta e rimangono nel database:
**non cancellare il volume dati** durante aggiornamenti o riavvii. In produzione
impostare `VAPID_SUBJECT` con un contatto reale e `APP_ORIGIN` con l'origine HTTPS.
Non mettere il database o il file `.env` nel repository.

Gli avvisi sono raggruppati per zona e deduplicati per impianto, carburante,
modalita e prezzo per 90 giorni; una comunicazione della stessa cifra il giorno
dopo non genera una nuova notifica. Cambiare la zona azzera la deduplicazione.
Invii falliti vengono ritentati, sottoscrizioni scadute (404/410) eliminate.
Se la ricerca corrente non riesce o i dettagli necessari non sono disponibili,
gli invii vengono sospesi per quel monitoraggio e ritentati al ciclo seguente.
Non sono notifiche istantanee di ogni variazione: il job deve essere eseguito.

## Pubblicazione persistente con HTTPS

Sono inclusi `Dockerfile`, `compose.yml` e `Caddyfile`. Richiede Docker Compose,
un dominio che punti al server e le porte 80/443 pubblicamente raggiungibili.

Creare `.env` nella cartella del progetto, ad esempio:

```dotenv
DOMAIN=carburanti.tuodominio.it
VAPID_SUBJECT=mailto:gestore@tuodominio.it
```

Poi:

```powershell
docker compose up -d --build
```

Caddy gestisce TLS, l'app non espone direttamente la porta API e i volumi
preservano dati e certificati. `restart: unless-stopped` riavvia i servizi.
Non usare `docker compose down -v` se vuoi conservare sottoscrizioni e chiavi.
Docker/hosting non sono necessari per lo sviluppo locale.

Per un hosting differente: build con `npm run build`, avvio `npm start`,
Node 24, `NODE_ENV=production`, `HOST=0.0.0.0`, `APP_ORIGIN=https://...`,
`VAPID_SUBJECT=mailto:...` e `DATA_DIR` su disco persistente. Mettere un reverse
proxy HTTPS davanti. `TRUST_PROXY=1` e adatto a **un solo proxy fidato** che
riscrive X-Forwarded-For; non esporre il backend direttamente in quel caso.
L'architettura e pensata per una singola istanza con massimo 1000 monitoraggi,
non per serverless o repliche multiple con database separati.

## Mappa, geocodifica e privacy

La mappa usa [OpenStreetMap](https://www.openstreetmap.org/copyright).
Rispettare la [tile usage policy](https://operations.osmfoundation.org/policies/tiles/):
nessun download massivo o prefetch/offline delle mappe. Le attribuzioni sono visibili.

Gli indirizzi vengono cercati tramite [Photon](https://photon.komoot.io/):
il servizio pubblico ammette un uso moderato, puo limitare il traffico e non
garantisce disponibilita. La ricerca parte solo su invio, non ad ogni tasto.
Il backend limita le chiamate globali a meno di una al secondo e memorizza
i risultati per 7 giorni. Per traffico significativo configurare `GEOCODER_URL`
con un'istanza Photon propria o un servizio compatibile: non affidarsi alla
demo pubblica come servizio con SLA.

Le coordinate delle ricerche e delle zone monitorate vengono inoltrate al
servizio MIMIT, senza le credenziali push. Gli indirizzi digitati passano al backend e a Photon; i tile comunicano a OSM
l'area visualizzata e l'IP del browser. Evitare indirizzi riservati. La posizione
GPS viene acquisita solo su richiesta. Attivando un monitoraggio, coordinate,
raggio, filtri ed endpoint push sono salvati sul server; le credenziali per
gestirlo rimangono nel browser. Nessun tracciamento GPS in background.
Disattivare il monitoraggio elimina sottoscrizione e storico degli avvisi.
Svuotare i dati del browser prima di disattivarlo puo impedire la gestione della
vecchia sottoscrizione fino alla sua scadenza presso il gateway.

Prima di un lancio pubblico il gestore deve predisporre informativa privacy,
contatti reali, backup con accesso limitato, retention e dimensionamento adeguati.
L'app non e un servizio ufficiale del Ministero.

## Comandi di sviluppo

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run lint
npm.cmd run test:e2e
```

I test backend usano il runner integrato di Node e SQLite in memoria. I test
browser usano fixture dichiarate solo nei test, mai nell'app. Consultare
`playwright.config.ts` per il browser locale/CI.
