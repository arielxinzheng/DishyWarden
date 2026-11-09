import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './components/Dashboard';
import Settings from './pages/Settings';
import AlertsPage from './pages/Alerts';
import ObstructionMap from './pages/ObstructionMap';
import AlignmentPage from './pages/AlignmentPage';
import SatelliteRadar from './pages/SatelliteRadar';
import { ErrorBoundary } from './components/ErrorBoundary';
import { DishProvider } from './hooks/useDish';

function App() {
  return (
    // 最外层: 连布局/导航崩了也能兜住, 而不是整页白屏
    // label 是翻译键（不是文案）：ErrorBoundary 内部再 t 一次，切语言时跟着变
    <ErrorBoundary label="alerts:shell.area_app">
      <DishProvider refreshInterval={30000}>
        <ErrorBoundary label="alerts:shell.area_layout">
          <Routes>
            <Route path="/" element={<Layout />}>
              {/* 每个页面单独包一层: 单页出错不影响侧栏导航和切页 */}
              <Route index element={<ErrorBoundary label="layout:nav_dashboard"><Dashboard /></ErrorBoundary>} />
              <Route path="obstruction" element={<ErrorBoundary label="layout:nav_obstruction"><ObstructionMap /></ErrorBoundary>} />
              <Route path="alignment" element={<ErrorBoundary label="layout:nav_alignment"><AlignmentPage /></ErrorBoundary>} />
              <Route path="satellites" element={<ErrorBoundary label="layout:nav_satellites"><SatelliteRadar /></ErrorBoundary>} />
              <Route path="alerts" element={<ErrorBoundary label="layout:nav_alerts"><AlertsPage /></ErrorBoundary>} />
              <Route path="settings" element={<ErrorBoundary label="layout:nav_settings"><Settings /></ErrorBoundary>} />
            </Route>
          </Routes>
        </ErrorBoundary>
      </DishProvider>
    </ErrorBoundary>
  );
}

export default App;