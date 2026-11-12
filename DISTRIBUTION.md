# Distribuzione OpenCode pronta all'installazione

Questo branch non sostituisce il branch sorgente `update/v6.2.2-mistral-vibe`.
Distribuisce la build di `0d6e5b33510f06242012a73e6869881847672563`, prodotta con
Node.js 24.22.3 e pnpm 11.28.9 dal lockfile, senza modifiche al codice del plugin.

- `dist/` è tracciata: include server, TUI, GUI, dati e lettore Python Mistral Vibe.
- Il manifesto runtime non contiene script di installazione/build, dipendenze
  di sviluppo o selezione del package manager. Le dipendenze runtime e i peer
  originali sono conservati.
- `runtime-artifact.json` registra sorgente, lockfile e digest dell'intera build.
- Il lockfile e i test upstream conservati nel repository descrivono la build
  sorgente; non usare il suo `pnpm install --frozen-lockfile` sul manifesto
  runtime, intenzionalmente ridotto. Compilare dal commit sorgente invece.

Per produrre un aggiornamento: checkout pulito del commit sorgente, installazione
con `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm run build`, test
mirati e verifica del pacchetto. Preparare poi il manifesto runtime e pubblicare
la build e il nuovo digest sul branch di distribuzione. Gli utilizzatori devono
fissare un hash completo del commit, non il nome mobile del branch.

La distribuzione non contiene credenziali o dipendenze `node_modules/`.
Runtime e login Vibe devono essere disponibili sull'host OpenCode e non vengono
trasferiti dal desktop. Il test di contratto di questo branch si esegue con
`node --test tests/runtime-distribution.test.mjs`, senza inferenze né rete.
