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
    <ErrorBoundary label="应用">
      <DishProvider refreshInterval={30000}>
        <ErrorBoundary label="界面布局">
          <Routes>
            <Route path="/" element={<Layout />}>
              {/* 每个页面单独包一层: 单页出错不影响侧栏导航和切页 */}
              <Route index element={<ErrorBoundary label="仪表盘"><Dashboard /></ErrorBoundary>} />
              <Route path="obstruction" element={<ErrorBoundary label="障碍图"><ObstructionMap /></ErrorBoundary>} />
              <Route path="alignment" element={<ErrorBoundary label="校准"><AlignmentPage /></ErrorBoundary>} />
              <Route path="satellites" element={<ErrorBoundary label="卫星雷达"><SatelliteRadar /></ErrorBoundary>} />
              <Route path="alerts" element={<ErrorBoundary label="告警"><AlertsPage /></ErrorBoundary>} />
              <Route path="settings" element={<ErrorBoundary label="设置"><Settings /></ErrorBoundary>} />
            </Route>
          </Routes>
        </ErrorBoundary>
      </DishProvider>
    </ErrorBoundary>
  );
}

export default App;