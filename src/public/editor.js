/*
 * CodeMirror 5 的包裝。vendor 進 /admin/vendor/codemirror.js（單一檔案、無 build step）。
 * CodeMirror 載不起來時退回純 <textarea> —— 編輯器掛掉不該讓後台整個不能用。
 */
'use strict';

window.LocalMonkeyEditor = (function createEditorFactory() {
  const OPTIONS = {
    mode: 'javascript',
    lineNumbers: true,
    lineWrapping: false,
    matchBrackets: true,
    autoCloseBrackets: true,
    styleActiveLine: true,
    indentUnit: 2,
    tabSize: 2,
    theme: 'localmonkey',
    viewportMargin: 30,
  };

  /**
   * @param {HTMLTextAreaElement} textarea
   * @param {{ onChange?: (value: string) => void, onSave?: () => void }} handlers
   */
  function createEditor(textarea, handlers = {}) {
    const onChange = handlers.onChange ?? (() => {});
    const onSave = handlers.onSave ?? (() => {});

    const save = () => {
      onSave();
      return false; // 不要讓瀏覽器跳「儲存網頁」
    };

    if (!window.CodeMirror) {
      textarea.addEventListener('input', () => onChange(textarea.value));
      textarea.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault();
          save();
        }
      });

      return {
        getValue: () => textarea.value,
        setValue: (value) => {
          textarea.value = value;
        },
        focus: () => textarea.focus(),
        refresh: () => {},
        fallback: true,
      };
    }

    const instance = window.CodeMirror.fromTextArea(textarea, {
      ...OPTIONS,
      extraKeys: {
        'Ctrl-S': save,
        'Cmd-S': save,
        Tab: (editor) => editor.execCommand('insertSoftTab'),
      },
    });

    instance.on('change', () => onChange(instance.getValue()));

    return {
      getValue: () => instance.getValue(),
      setValue: (value) => {
        instance.setValue(value ?? '');
        instance.clearHistory(); // 換腳本時不要還能 undo 回上一支的內容
      },
      focus: () => instance.focus(),
      refresh: () => instance.refresh(),
      instance,
      fallback: false,
    };
  }

  return { createEditor, OPTIONS };
})();
