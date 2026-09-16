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
    setApiKey: (value) => invoke('set_api_key', { value }),
    logout: () => invoke('logout'),
    getDataDirectory: () => invoke('get_data_directory'),
    getFloatTheme: () => invoke('get_float_theme'),
    openLog: () => invoke('open_log'),
    beginFloatDrag: () => invoke('begin_float_drag'),
    moveFloat: (delta) => invoke('move_float', { delta }),
    endFloatDrag: () => invoke('end_float_drag'),
    showFloatMenu: () => invoke('show_float_menu'),
    openAdminPage: () => invoke('open_admin_page'),
    openPanel: () => invoke('open_panel'),
    onState: (callback) => subscribe('state', callback),
    onFloatColor: (callback) => subscribe('float-color', callback),
    onNavigate: (callback) => subscribe('navigate', callback),
    close: () => invoke('close_panel')
  };
})();
