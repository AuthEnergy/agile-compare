// Composition root. Wires the typed flows/diagnostics into the UI shell.
// Phase 4 is landing screen-by-screen: the shell, Connect screen (with real key
// validation + opt-in storage), theme, router and the offline replay validator
// are live here; meter/fetch/results/timing screens follow.
import './ui/styles.css';
import { App } from './ui/app';
import { replayDiagnostics } from './diagnostics/replay';
import { buildSampleRun } from './data/sample';
import { initTooltips } from './ui/tooltip';

// Open a native file picker and hand back the file's text (no upload — read
// locally). The CSP allows this; nothing leaves the device.
function pickTextFile(onText: (text: string) => void): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.style.display = 'none';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onText(typeof reader.result === 'string' ? reader.result : '');
    reader.readAsText(file);
  });
  document.body.append(input);
  input.click();
}

function mount(): void {
  const root = document.querySelector<HTMLDivElement>('#app');
  if (!root) return;

  const app = new App(root, {
    connect: () => {
      void app.runLive(app.getState().apiKey);
    },
    useSample: () => {
      app.showResults(buildSampleRun(), 'sample household · illustrative data');
    },
    replayFile: () => {
      pickTextFile((text) => {
        const result = replayDiagnostics(text);
        if (!result.ok) {
          app.setState({ statusMessage: result.message });
        } else if (result.kind === 'export') {
          app.showExportResults(result.exportRun, `${result.meta.appVersion} · offline replay`);
        } else {
          app.showResults(result.run, `${result.meta.appVersion} · offline replay`);
        }
      });
    },
  });

  app.mount();
  initTooltips();
}

mount();
