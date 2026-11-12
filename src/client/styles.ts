export const styles = `
.dl {
  --dl-bg:var(--dsw-alias-bg-base,#fff);
  --dl-layer:var(--dsw-alias-bg-layer-1,#f6f7f8);
  --dl-line:var(--dsw-alias-border-l1,#e5e7eb);
  --dl-muted:var(--dsw-alias-label-secondary,#747b86);
  --dl-accent:var(--dsw-alias-state-business-primary,#4a69d8);
  color:var(--dsw-alias-label-primary,#242832);
  font:var(--dsw-font-s-14,400 14px/22px var(--dsw-font-family,system-ui,sans-serif));
  box-sizing:border-box;
}
.dl * {
  box-sizing:border-box;
}
.dl h2,.dl h3,.dl h4,.dl p {
  margin:0;
}
.dl h2 {
  font:var(--dsw-font-m-18,500 16px/28px var(--dsw-font-family,system-ui,sans-serif));
}
.dl h3,.dl h4 {
  font:var(--dsw-font-s-strong-14,500 14px/22px var(--dsw-font-family,system-ui,sans-serif));
}
.dl strong {
  font-weight:500;
}
.dl small,.dl .muted {
  color:var(--dl-muted);
  font:var(--dsw-font-xxs-12,400 12px/18px var(--dsw-font-family,system-ui,sans-serif));
}
.dl small {
  display:block;
}
.dl button,.dl input,.dl textarea {
  font:inherit;
  color:inherit;
}
.dl button {
  cursor:pointer;
  background:transparent;
  border:1px solid transparent;
  border-radius:7px;
  padding:7px 10px;
}
.dl button:hover {
  background:var(--dsw-alias-interactive-bg-hover,rgba(120,130,150,.09));
}
.dl button:disabled {
  opacity:.42;
  cursor:default;
}
.dl button:focus-visible,.dl input:focus-visible,.dl textarea:focus-visible,.dl summary:focus-visible {
  outline:2px solid var(--dl-accent);
  outline-offset:2px;
}
.dl .primary {
  background:var(--dl-accent);
  color:#fff;
}
.dl .primary:hover {
  filter:brightness(1.08);
  background:var(--dl-accent);
}
.dl .outline {
  border-color:var(--dl-line);
}
.dl .danger,.dl .error,.dl .dl-error {
  color:var(--dsw-alias-state-error-primary,#c23c45);
}
.dl .error,.dl .dl-error {
  overflow-wrap:anywhere;
  padding:8px 0;
}
.dl .status {
  display:flex;
  flex-shrink:0;
  white-space:nowrap;
  align-items:center;
  gap:6px;
  color:var(--dl-muted);
  font:var(--dsw-font-xxs-12,400 12px/18px var(--dsw-font-family,system-ui,sans-serif));
}
.dl .dot {
  width:6px;
  height:6px;
  border-radius:50%;
  display:inline-block;
  background:#9b9fa8;
  flex:none;
}
.dl .dot.online {
  background:var(--dsw-alias-state-success-primary,#429976);
}
.dl input:not([type=checkbox]),.dl textarea {
  width:100%;
  border:1px solid var(--dl-line);
  border-radius:7px;
  background:var(--dl-bg);
  padding:9px 10px;
  min-width:0;
}
.dl textarea {
  resize:vertical;
  min-height:80px;
}
.dl input[type=checkbox] {
  margin-right:7px;
}
.dl label {
  display:block;
  margin:12px 0;
}
.dl label>input:not([type=checkbox]),.dl label>textarea {
  margin-top:6px;
}
.dl .row {
  display:flex;
  align-items:center;
  gap:8px;
  min-width:0;
}
.dl .between {
  justify-content:space-between;
}
.dl .grow {
  flex:1;
  min-width:0;
}
.dl .actions,.dl .dl-actions {
  display:flex;
  align-items:center;
  gap:8px;
  flex-wrap:wrap;
}
.dl .path {
  overflow-wrap:anywhere;
  font:var(--dsw-font-xxs-12,400 12px/18px var(--dsw-font-family,system-ui,sans-serif));
  color:var(--dl-muted);
}
.dl .ellipsis {
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
}
.dl .empty {
  padding:28px 12px;
  text-align:center;
  color:var(--dl-muted);
}
.dl .empty p {
  margin-bottom:10px;
}
.dl .section-label {
  font:var(--dsw-font-xs-13,400 13px/20px var(--dsw-font-family,system-ui,sans-serif));
  color:var(--dl-muted);
  margin:18px 0 8px;
}
.dl .divider {
  border-top:1px solid var(--dl-line);
  padding-top:14px;
  margin-top:14px;
}
/* Stack the shared footer entries through the host's slot anchor. The anchor
   uses display: contents, so its parent owns the actual flex layout. */
:has(> [data-slot="sidebar.footer.action"] > .dl-footer) {
  flex-direction: column;
  align-items: stretch;
  align-self: stretch;
  max-width: 100%;
  gap: 4px;
}
.dl-footer {
  display: inline-flex;
  flex: none;
  width: 100%;
  min-width: 0;
}
.dl .device-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  position: relative;
  width: 100%;
  height: 36px;
  padding: 7px 8px;
  text-align: left;
  border: 0;
  border-radius: var(--dsw-radius-sm,6px);
  color: var(--dsw-alias-label-secondary);
  flex: none;
}
.dl .device-trigger.rail {
  justify-content: center;
  padding: 7px;
}
.dl .device-trigger[aria-expanded=true] {
  background:var(--dsw-alias-interactive-bg-hover);
}
.dl .device-trigger>.dot {
  position:absolute;
  right:4px;
  top:4px;
  border:1px solid var(--dl-bg);
  width:7px;
  height:7px;
}
.dl-device-icon {
  display:inline-block;
  position:relative;
  width:16px;
  height:12px;
  margin-bottom:4px;
  border:1.5px solid currentColor;
  border-radius:2px;
  flex:none;
}
.dl-device-icon:before {
  content:'';
  position:absolute;
  width:2px;
  height:3px;
  left:5.5px;
  bottom:-4px;
  background:currentColor;
}
.dl-device-icon:after {
  content:'';
  position:absolute;
  width:8px;
  height:1.5px;
  left:2.5px;
  bottom:-5px;
  background:currentColor;
}
.dl-favorites {
  margin-bottom:16px;
}
.dl-favorites .favorites {
  min-width:0;
}
.dl-popover .dl-panel-tabs { margin:0 18px;flex:none; }
.dl-workspace-group + .dl-workspace-group { margin-top:16px; }
.dl-workspace-group .section-label { margin:0; }
.dl-favorites .favorite-row {
  display:flex;
  align-items:center;
  gap:4px;
}
.dl-favorites .favorite-row>button:first-child {
  min-width:0;
  flex:1;
  text-align:left;
  padding:6px 9px;
}
.dl-favorites .favorite-row .remove {
  opacity:0;
  padding:4px;
}
.dl-favorites .favorite-row:hover .remove,.dl-favorites .favorite-row:focus-within .remove {
  opacity:1;
}
.dl-favorites .section-label {
  margin:0 0 4px;
  padding:4px 5px;
}
.dl-popover {
  position:fixed;
  left:16px;
  bottom:96px;
  width:400px;
  height:560px;
  max-height:calc(100dvh - 118px);
  max-width:calc(100vw - 32px);
  background:var(--dl-bg);
  border:1px solid var(--dl-line);
  border-radius:14px;
  box-shadow:0 16px 55px #0002;
  display:flex;
  flex-direction:column;
  pointer-events:auto;
  z-index:80;
  overflow:hidden;
}
.dl-popover header,.dl-preview header {
  padding:15px 18px;
  border-bottom:1px solid var(--dl-line);
  flex:none;
}
.dl-popover header h2 {
  font:var(--dsw-font-s-strong-14,500 14px/22px var(--dsw-font-family,system-ui,sans-serif));
}
.dl-popover .body {
  padding:14px 18px;
  overflow:auto;
  flex:1;
  min-height:0;
}
.dl-popover footer {
  border-top:1px solid var(--dl-line);
  padding:10px 14px;
  flex:none;
}
.dl-popover .search {
  padding:0 18px;
  margin-top:14px;
}
.dl-popover .search input {
  background:var(--dl-layer);
}
.dl-device-row {
  display:flex;
  width:100%;
  align-items:center;
  gap:12px;
  text-align:left;
  padding:12px 5px!important;
}
.dl-device-row .device-symbol {
  width:38px;
  height:38px;
  display:grid;
  place-items:center;
  border-radius:10px;
  background:var(--dl-layer);
  font-size:23px;
}
.dl-device-row strong {
  display:block;
  font:var(--dsw-font-s-strong-14,500 14px/22px var(--dsw-font-family,system-ui,sans-serif));
}
.dl .resource-row {
  display:flex;
  align-items:center;
  gap:6px;
  border-radius:8px;
  margin:3px 0;
}
.dl .resource-main {
  display:flex;
  align-items:center;
  gap:10px;
  text-align:left;
  flex:1;
  min-width:0;
  padding:9px 5px;
}
.dl .resource-main strong {
  display:block;
  font-weight:500;
}
.dl .resource-main small {
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
  max-width:275px;
}
.dl .star {
  font-size:19px;
  color:var(--dl-muted);
  padding:6px;
}
.dl .star.selected {
  color:var(--dl-accent);
}
.dl .tabs {
  display:flex;
  gap:4px;
  border-bottom:1px solid var(--dl-line);
  margin:14px 0;
}
.dl .tabs button {
  border-radius:0;
  padding:9px 12px;
  border-bottom:2px solid transparent;
}
.dl .tabs button[aria-selected=true] {
  border-bottom-color:var(--dl-accent);
  color:var(--dl-accent);
}
.dl .code {
  font:500 28px/40px var(--ds-font-family-code,monospace);
  letter-spacing:5px;
  padding:14px 0;
}
.dl fieldset {
  border:1px solid var(--dl-line);
  border-radius:9px;
  margin:14px 0;
  padding:5px 12px 12px;
}
.dl legend {
  font:var(--dsw-font-xxs-12,400 12px/18px var(--dsw-font-family,system-ui,sans-serif));
  color:var(--dl-muted);
  padding:0 4px;
}
.dl details>summary {
  cursor:pointer;
  padding:9px 0;
}
.dl .scope-hint {
  margin-top:10px;
}
.dl-preview {
  height:100%;
  min-width:0;
  background:var(--dl-bg);
  display:flex;
  flex-direction:column;
}
.dl-preview .body {
  padding:20px;
  overflow:auto;
  flex:1;
  min-height:0;
}
.dl-preview footer {
  border-top:1px solid var(--dl-line);
  padding:14px 18px;
  flex:none;
}
.dl-preview .message {
  margin:20px 0;
}
.dl-preview .message strong {
  font:var(--dsw-font-xxs-strong-12,500 12px/18px var(--dsw-font-family,system-ui,sans-serif));
  color:var(--dl-muted);
  display:block;
  margin-bottom:6px;
}
.dl-preview .message p,.dl pre {
  white-space:pre-wrap;
  overflow-wrap:anywhere;
  font:var(--dsw-font-markdown-base,400 14px/24px var(--dsw-font-family,system-ui,sans-serif));
}
.dl-preview .message[data-role=user] {
  background:var(--dl-layer);
  padding:12px;
  border-radius:10px;
}
.dl-fallback {
  position:fixed;
  right:12px;
  top:12px;
  bottom:12px;
  width:420px;
  max-width:calc(100vw - 24px);
  border:1px solid var(--dl-line);
  border-radius:12px;
  box-shadow:0 15px 50px #0002;
  pointer-events:auto;
  z-index:85;
  overflow:hidden;
}
.dl-fallback .dl-preview header {
  padding-right:46px;
}
.dl-preview header h2 {
  overflow-wrap:anywhere;
}
.dl-settings {
  padding:24px;
  max-width:800px;
  margin:0 auto;
  overflow:auto;
  height:100%;
}
.dl-settings>section {
  border-bottom:1px solid var(--dl-line);
  padding:20px 0;
}
.dl-settings h2 {
  font:var(--dsw-font-l-20,500 20px/28px var(--dsw-font-family,system-ui,sans-serif));
}
.dl-settings article {
  padding:10px 0;
}
.dl-settings article+article {
  border-top:1px solid var(--dl-line);
}
.dl-settings-modal {
  position:fixed;
  inset:5vh max(20px,calc((100vw - 800px)/2));
  background:var(--dl-bg);
  border:1px solid var(--dl-line);
  border-radius:14px;
  box-shadow:0 16px 80px #0003;
  pointer-events:auto;
  z-index:90;
  overflow:auto;
}
.dl-settings-modal .dl-settings {
  height:auto;
}
.dl-tasks {
  height:100%;
  overflow:auto;
  padding:28px 32px;
  background:var(--dl-bg);
}
.dl-tasks>div {
  max-width:860px;
  margin:0 auto;
}
.dl-task-link { display:block;width:100%;text-align:left;padding:0!important; }
.dl-task-link .row { gap:12px; }
.dl-task-link small { margin-top:5px; }
.dl-task-link .dl-excerpt { margin:12px 0 8px;color:var(--dl-muted);overflow-wrap:anywhere; }
.dl .dl-link { color:var(--dl-accent); }
.dl-task-group { margin-top:26px; }
.dl-task-group h3 { display:flex;gap:8px;align-items:center; }
.dl-task-search { margin-top:24px; }
.dl-conversation { width:100%;height:100%;min-height:0;min-width:0;flex:1;display:flex;flex-direction:column;background:var(--dl-bg);container-type:inline-size; }
.dl-conversation-header { min-height:50px;padding:10px 20px;display:flex;align-items:center;gap:10px;border-bottom:.5px solid var(--dsw-alias-border-l3,var(--dl-line));flex-shrink:0; }
.dl .dl-conversation-header h2 { font:var(--dsw-font-s-strong-14,500 14px/20px var(--dsw-font-family));min-width:0;flex:0 1 auto; }
.dl-remote-source { color:var(--dl-muted);font:var(--dsw-font-xxs-12);min-width:70px;display:flex;align-items:center;gap:6px; }
.dl-source-part { display:inline-flex;align-items:center;gap:5px;min-width:0; }
.dl-source-part .dl-device-icon { transform:scale(.8);margin-right:-2px; }
.dl-meta { display:flex!important;flex-wrap:wrap;gap:4px 14px; }
.dl-facts { display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px 16px;margin:12px 0; }
.dl-facts dt { color:var(--dl-muted); }
.dl-facts dd { margin:0;overflow-wrap:anywhere; }
.dl-management>section { padding:18px 0;border-bottom:1px solid var(--dl-line); }
.dl-management .actions { margin-top:12px; }
.dl-conversation-header .status { margin-left:auto; }
.dl .dl-icon-button { display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;width:28px;height:28px;padding:0;color:var(--dsw-alias-label-tertiary,var(--dl-muted));border:0;border-radius:var(--dsw-radius-sm,6px); }
.dl-back svg { transform:rotate(180deg); }
.dl-context-details { position:relative; }
.dl-context-details summary { cursor:pointer;color:var(--dl-muted);font:var(--dsw-font-xxs-12); }
.dl-context-details>div { position:absolute;top:28px;right:0;z-index:5;background:var(--dl-bg);border:1px solid var(--dl-line);border-radius:8px;padding:16px;width:300px;max-width:80vw;box-shadow:0 5px 24px #0002;display:flex;flex-direction:column;gap:8px; }
.dl-transcript { min-height:0;flex:1;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable; }
.dl-transcript-content { width:calc(100% - 48px);max-width:var(--dsh-chat-user-width,clamp(680px,64cqw,920px));margin:auto;padding:16px 0 32px; }
.dl-start { text-align:center;padding:48px 0; }
.dl-start p { margin-top:12px; }
.dl-turn { padding:0 0 24px; }
.dl-chat-message { overflow-wrap:anywhere;font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px)); }
.dl-chat-message.user { display:flex;flex-direction:column;align-items:flex-end;margin-bottom:16px; }
.dl-user-bubble { background:var(--dsw-specific-bubble,var(--dl-layer));border-radius:var(--dsw-radius-xl,16px);padding:10px 16px;white-space:pre-wrap;max-width:70%; }
.dl-message-actions { display:flex;align-items:center;gap:12px;margin-top:12px;color:var(--dsw-alias-label-tertiary,var(--dl-muted));font:var(--dsw-font-xxs-12);min-height:28px; }
.dl-chat-message.user .dl-message-actions { flex-direction:row-reverse; }
.dl-chat-message.assistant .dl-message-actions { margin-left:-6px; }
.dl-markdown { font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px)); }
.dl .dl-markdown p { margin:0 0 12px; }
.dl .dl-markdown h1,.dl .dl-markdown h2,.dl .dl-markdown h3 { margin:20px 0 10px;line-height:1.5; }
.dl .dl-markdown h1 { font-size:1.5em; }.dl .dl-markdown h2 { font-size:1.3em; }.dl .dl-markdown h3 { font-size:1.1em; }
.dl .dl-markdown pre { overflow:auto;max-width:100%; }.dl-markdown table { display:block;overflow:auto;max-width:100%; }
.dl-notice { background:var(--dl-layer);padding:10px 12px;border-radius:8px;margin:8px 0!important;color:var(--dl-muted); }
.dl-turn-status { color:var(--dsw-alias-label-tertiary,var(--dl-muted));font:var(--dsw-font-xs-13,400 13px/20px var(--dsw-font-family));padding:8px 0 12px;margin-bottom:16px;border-bottom:.5px solid var(--dsw-alias-border-l1,var(--dl-line)); }
.dl-turn-status button { color:var(--dl-accent); }
.dl-compose-area { padding:16px 24px 4px;flex-shrink:0;background:linear-gradient(180deg,transparent,var(--dl-bg) 16px); }
.dl-chat-composer { max-width:calc(var(--dsh-chat-user-width,clamp(680px,64cqw,920px)) + 32px);margin:auto;border:0;border-radius:var(--dsw-radius-panel,24px);padding:8px 0 0;background:var(--dsw-specific-input-major,var(--dl-bg));--dsw-elevation-stroke-color:var(--dsw-alias-border-l2);box-shadow:var(--dsw-elevation-soft,0 0 0 .5px var(--dl-line),0 4px 20px #00000008);display:flex;flex-direction:column;gap:12px; }
.dl .dl-chat-composer textarea { display:block;border:0;border-radius:0;background:transparent;resize:none;min-height:36px;max-height:240px;padding:4px 14px 0;box-shadow:none;font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px));outline:none; }
.dl-chat-composer:focus-within { --dsw-elevation-stroke-color:var(--dsw-alias-border-l3); }
.dl-chat-composer textarea::placeholder { color:var(--dsw-alias-label-caption,var(--dl-muted)); }
.dl-composer-toolbar { display:flex;justify-content:space-between;align-items:center;gap:12px;padding:2px 8px 6px;min-width:0;flex-wrap:wrap; }
.dl .dl-execution-target { padding-left:6px;max-width:40%;color:var(--dsw-alias-label-tertiary,var(--dl-muted)); }
.dl-composer-trailing { display:flex;gap:12px;align-items:center;min-width:0;margin-left:auto; }
.dl .dl-send { width:34px;height:34px;flex-shrink:0;display:grid;place-items:center;padding:0;border:0;border-radius:999px;background:var(--dsw-alias-button-info-fill,var(--dl-accent));color:#fff;transform:translateY(-2px); }
.dl .dl-send:hover:not(:disabled) { background:var(--dsw-alias-button-info-hover,var(--dl-accent)); }
.dl .dl-send:disabled { opacity:.4; }
.dl-models { min-width:0;position:relative; }
.dl .dl-model-trigger { border-radius:var(--dsw-radius-sm);min-width:0;max-width:min(360px,60cqw);height:28px;color:var(--dsw-alias-label-secondary);background:transparent;border:0;display:flex;align-items:center;gap:4px;padding:0 4px 0 8px;font:var(--dsw-font-xs-13,400 13px/20px var(--dsw-font-family)); }
.dl-model-name { overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0; }
.dl-model-effort { color:var(--dsw-alias-label-caption);white-space:nowrap; }
.dl-model-chevron { display:flex;color:var(--dsw-alias-label-caption);flex:none;transition:transform .12s; }
.dl-model-chevron.open { transform:rotate(180deg); }
.dl-model-menu { z-index:1100;--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);width:max-content;min-width:min(240px,100vw - 32px);max-width:min(420px,100vw - 32px);max-height:min(360px,100dvh - 32px);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);border:0;display:flex;flex-direction:column;padding:4px;position:fixed;overflow:hidden; }
.dl-model-menu * { box-sizing:border-box; }
.dl-model-options { min-height:0;overflow-y:auto; }
.dl-model-cell,.dl-model-option { border-radius:var(--dsw-radius-md);width:100%;min-height:34px;color:inherit;text-align:left;cursor:pointer;background:transparent;border:0;display:flex;align-items:center;gap:6px;padding:5px 8px;font:var(--dsw-font-xs-13,400 13px/20px var(--dsw-font-family));outline:none; }
.dl-model-cell:hover,.dl-model-cell:focus-visible,.dl-model-option:hover,.dl-model-option:focus-visible { background:var(--dsw-alias-interactive-bg-hover); }
.dl-model-cell>span:first-child { white-space:nowrap; }
.dl-model-value { color:var(--dsw-alias-label-tertiary);text-align:right;min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
.dl-model-cell>svg { flex:none;color:var(--dsw-alias-menu-icon); }
.dl-model-option>.dl-model-name { flex:1; }
.dl-model-check { flex:0 0 14px;display:grid;place-items:center; }
.dl-model-search { font:var(--dsw-font-xs-13);padding:7px;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:inherit;min-width:0;outline:none; }
.dl-model-search:focus-visible { box-shadow:inset 0 0 0 1px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary)); }
.dl-model-empty { color:var(--dsw-alias-label-tertiary);padding:8px;font:var(--dsw-font-xxs-12); }
.dl-choice-field { display:flex;flex-direction:column;gap:6px;margin:12px 0;min-width:0; }
.dl .dl-choice-trigger { display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;min-width:0;min-height:36px;text-align:left;padding:7px 10px;border:1px solid var(--dl-line);border-radius:var(--dsw-radius-md);background:var(--dl-bg); }
.dl-choice-trigger>span { overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
.dl-choice-trigger>svg { flex:none;color:var(--dsw-alias-label-caption); }
.dl-choice-trigger[aria-expanded=true]>svg { transform:rotate(180deg); }
.dl-choice-menu { min-width:0;max-width:calc(100vw - 24px); }
.dl-choice-menu .dl-model-option { font:var(--dsw-font-s-14,400 14px/22px var(--dsw-font-family)); }
.dl-choice-menu .active { background:var(--dsw-alias-interactive-bg-hover); }
.dl-chat-composer>small,.dl-chat-composer>.error { padding:0 14px; }
.dl-draft-note { text-align:center;margin-top:6px;min-height:18px; }
@media(max-width:650px) {
  .dl-conversation-header { padding:8px 12px;gap:6px; }
  .dl-remote-source { display:none; }
  .dl-transcript-content { width:calc(100% - 32px);padding:16px 0 24px; }
  .dl-user-bubble { max-width:90%; }
  .dl-compose-area { padding:12px 16px 4px; }
  .dl .dl-model-trigger { max-width:calc(100cqw - 92px); }
  .dl .dl-execution-target { max-width:100%; }
  .dl-composer-trailing { gap:8px; }
}
.dl-composer {
  border:1px solid var(--dl-line);
  border-radius:13px;
  padding:18px;
  margin:24px 0;
  background:var(--dl-layer);
}
.dl-composer textarea {
  min-height:130px;
  margin:14px 0;
}
.dl-task {
  border:1px solid var(--dl-line);
  border-radius:11px;
  padding:14px 16px;
  margin:12px 0;
  background:var(--dl-bg);
}
.dl-task .task-prompt {
  margin:9px 0;
  white-space:pre-wrap;
  overflow-wrap:anywhere;
}
.dl-task pre {
  max-height:320px;
  overflow:auto;
  margin:12px 0;
}
.dl-task .task-output {
  border-top:1px solid var(--dl-line);
  padding-top:12px;
}
.dl-task .actions {
  margin-top:12px;
}
.dl-task .task-state {
  font:var(--dsw-font-xxs-12,400 12px/18px var(--dsw-font-family,system-ui,sans-serif));
  border:1px solid var(--dl-line);
  border-radius:5px;
  padding:2px 6px;
  white-space:nowrap;
}
.dl-toast {
  position:fixed;
  bottom:24px;
  left:50%;
  transform:translateX(-50%);
  background:var(--dl-bg);
  border:1px solid var(--dl-line);
  border-radius:9px;
  padding:10px 18px;
  box-shadow:0 8px 30px #0002;
  pointer-events:auto;
  z-index:110;
  max-width:calc(100vw - 32px);
}
.dl .dl-reference {
  max-width:min(100%,480px);
  color:var(--dl-accent);
  border-color:var(--dl-line);
  background:var(--dl-layer);
  padding:3px 7px;
  vertical-align:bottom;
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
  text-align:left;
}
@media(max-width:850px) {
  .dl-popover {
    left:12px;
    bottom:70px;
    max-height:calc(100dvh - 90px);
  }
  .dl-tasks {
    padding:18px;
  }
  .dl-favorites .favorite-row .remove {
    opacity:1;
  }
  .dl-settings-modal {
    inset:12px;
  }
  .dl-preview .body {
    padding:16px;
  }
}
`
