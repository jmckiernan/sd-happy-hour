export type AppDialogOptions = {
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  defaultValue?: string;
  placeholder?: string;
  danger?: boolean;
};

type DialogKind = 'alert' | 'confirm' | 'prompt';

type DialogRequest = AppDialogOptions & {
  kind: DialogKind;
  message: string;
};

let dialogEl: HTMLDialogElement | null = null;
let titleEl: HTMLElement | null = null;
let messageEl: HTMLElement | null = null;
let inputWrapEl: HTMLElement | null = null;
let inputEl: HTMLInputElement | null = null;
let actionsEl: HTMLElement | null = null;
let confirmBtn: HTMLButtonElement | null = null;
let cancelBtn: HTMLButtonElement | null = null;

let queue: Array<{ request: DialogRequest; resolve: (value: unknown) => void }> = [];
let active = false;

function getElements() {
  if (dialogEl) return;
  dialogEl = document.getElementById('app-dialog') as HTMLDialogElement | null;
  if (!dialogEl) return;
  titleEl = dialogEl.querySelector('[data-app-dialog-title]');
  messageEl = dialogEl.querySelector('[data-app-dialog-message]');
  inputWrapEl = dialogEl.querySelector('[data-app-dialog-input-wrap]');
  inputEl = dialogEl.querySelector('[data-app-dialog-input]');
  actionsEl = dialogEl.querySelector('[data-app-dialog-actions]');
  confirmBtn = dialogEl.querySelector('[data-app-dialog-confirm]');
  cancelBtn = dialogEl.querySelector('[data-app-dialog-cancel]');
}

function finish(value: unknown) {
  const current = queue.shift();
  current?.resolve(value);
  active = false;
  dialogEl?.close();
  void runNext();
}

function runNext() {
  if (active || queue.length === 0) return;
  getElements();
  const current = queue[0];
  if (!dialogEl || !titleEl || !messageEl || !inputWrapEl || !inputEl || !confirmBtn || !cancelBtn || !actionsEl) {
    current.resolve(fallbackResult(current.request));
    queue.shift();
    void runNext();
    return;
  }

  active = true;
  const { request } = current;
  const isAlert = request.kind === 'alert';
  const isPrompt = request.kind === 'prompt';
  const alertUsesBody = isAlert && Boolean(request.title || request.message.includes('\n'));
  const useMessageAsTitle = !alertUsesBody && !request.title && (isPrompt || request.kind === 'confirm' || isAlert);

  titleEl.textContent = request.title || (useMessageAsTitle ? request.message : isAlert ? 'Notice' : isPrompt ? 'Input needed' : 'Confirm');
  messageEl.textContent = useMessageAsTitle ? '' : request.message;
  messageEl.hidden = useMessageAsTitle || !request.message;

  inputWrapEl.hidden = !isPrompt;
  if (isPrompt) {
    inputEl.value = request.defaultValue ?? '';
    inputEl.placeholder = request.placeholder ?? '';
  }

  confirmBtn.textContent = request.confirmLabel || (isAlert ? 'OK' : isPrompt ? 'OK' : 'Confirm');
  cancelBtn.textContent = request.cancelLabel || 'Cancel';
  cancelBtn.hidden = isAlert;

  confirmBtn.classList.toggle('danger', Boolean(request.danger && !isAlert));
  actionsEl.classList.toggle('single', isAlert);

  dialogEl.showModal();
  queueMicrotask(() => {
    if (isPrompt) {
      inputEl?.focus();
      inputEl?.select();
    } else {
      confirmBtn?.focus();
    }
  });
}

function fallbackResult(request: DialogRequest): unknown {
  if (request.kind === 'alert') {
    window.alert(request.message);
    return undefined;
  }
  if (request.kind === 'confirm') {
    return window.confirm(request.message);
  }
  return window.prompt(request.message, request.defaultValue ?? '');
}

function enqueue<T>(request: DialogRequest): Promise<T> {
  return new Promise((resolve) => {
    queue.push({ request, resolve: resolve as (value: unknown) => void });
    void runNext();
  });
}

export function initAppDialog() {
  getElements();
  if (!dialogEl || !confirmBtn || !cancelBtn || !inputEl) return;

  confirmBtn.addEventListener('click', () => {
    const current = queue[0];
    if (!current) return;
    if (current.request.kind === 'prompt') {
      finish(inputEl!.value);
      return;
    }
    finish(current.request.kind === 'confirm');
  });

  cancelBtn.addEventListener('click', () => {
    const current = queue[0];
    if (!current) return;
    finish(current.request.kind === 'prompt' ? null : false);
  });

  dialogEl.addEventListener('cancel', (event) => {
    event.preventDefault();
    const current = queue[0];
    if (!current) return;
    finish(current.request.kind === 'alert' ? undefined : current.request.kind === 'prompt' ? null : false);
  });

  inputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      confirmBtn?.click();
    }
  });
}

export function appAlert(message: string, options: Pick<AppDialogOptions, 'title' | 'confirmLabel'> = {}): Promise<void> {
  return enqueue({ kind: 'alert', message, ...options });
}

export function appConfirm(message: string, options: Omit<AppDialogOptions, 'defaultValue' | 'placeholder'> = {}): Promise<boolean> {
  return enqueue({ kind: 'confirm', message, ...options });
}

export function appPrompt(
  message: string,
  defaultValue = '',
  options: Omit<AppDialogOptions, 'defaultValue'> = {},
): Promise<string | null> {
  return enqueue({ kind: 'prompt', message, defaultValue, ...options });
}
