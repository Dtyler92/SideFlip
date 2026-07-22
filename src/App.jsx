import { Routes, Route } from 'react-router-dom'
import Home from './pages/Home'
import NewProject from './pages/NewProject'
import ProjectDetail from './pages/ProjectDetail'
import SellProject from './pages/SellProject'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/new" element={<NewProject />} />
      <Route path="/project/:id" element={<ProjectDetail />} />
      <Route path="/project/:id/sell" element={<SellProject />} />
    </Routes>
  )
}
