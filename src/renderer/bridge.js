'use strict';

(() => {
  const tauri = window.__TAURI__;
  if (!tauri?.core?.invoke || !tauri?.event?.listen) {
    throw new Error('Tauri API 未初始化。');
  }

  const invoke = async (command, args) => {
    try {
      return await tauri.core.invoke(command, args);
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  };
  const subscribe = (event, callback) => {
    void tauri.event.listen(event, ({ payload }) => callback(payload));
  };

  window.sub2api = {
    getState: () => invoke('get_state'),
    cancelUpdate: () => invoke('cancel_update'),
    installUpdate: () => invoke('install_update'),
    closeUpdate: () => invoke('close_update'),
    onUpdateState: (callback) => {
      subscribe('update-state', callback);
      void invoke('get_update_state').then(callback);
    },
    refresh: () => invoke('refresh'),
    saveConfig: (values) => invoke('save_config', { values }),
    login: (values) => invoke('login', { values }),
    completeLogin: (values) => invoke('complete_login', { values }),
    logout: () => invoke('logout'),
    getDataDirectory: () => invoke('get_data_directory'),
    getFloatTheme: () => invoke('get_float_theme'),
    openLog: () => invoke('open_log'),
    beginFloatDrag: () => invoke('begin_float_drag'),
    moveFloat: (delta) => invoke('move_float', { delta }),
    endFloatDrag: () => invoke('end_float_drag'),
    showFloatMenu: () => invoke('show_float_menu'),
    openAdminPage: () => invoke('open_admin_page'),
    getCodexConfig: () => invoke('get_codex_config'),
    openCodexConfig: () => invoke('open_codex_config'),
    saveCodexConfig: (values) => invoke('save_codex_config', values),
    prepareModels: () => invoke('prepare_models'),
    listModelFiles: () => invoke('list_model_files'),
    readModels: () => invoke('read_models'),
    saveModels: (models) => invoke('save_models', { models }),
    listBackups: (app) => invoke('list_backups', { app }),
    previewBackup: (app, name) => invoke('preview_backup', { app, name }),
    deleteBackup: (app, name) => invoke('delete_backup', { app, name }),
    restoreBackup: (app, name) => invoke('restore_backup', { app, name }),
    openPanel: () => invoke('open_panel'),
    onState: (callback) => subscribe('state', callback),
    onFloatColor: (callback) => subscribe('float-color', callback),
    onNavigate: (callback) => subscribe('navigate', callback),
    close: () => invoke('close_panel')
  };
})();
