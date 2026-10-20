import { createPinia } from 'pinia';
import { createApp } from 'vue';

import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';

import '@vue-flow/core/dist/style.css';
import '@vue-flow/core/dist/theme-default.css';
import '@vue-flow/controls/dist/style.css';
import '@vue-flow/minimap/dist/style.css';
import 'element-plus/dist/index.css';
import './styles/global.css';

import App from './App.vue';

const app = createApp(App);
app.use(createPinia());
app.use(ElementPlus, { locale: zhCn });
app.mount('#app');
