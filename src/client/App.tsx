import { useMemo, useState } from 'react'
import type { AppBootstrap } from '../shared/types.js'
import './App.css'
import { Footer } from './components/Footer/Footer.js'
import { Header } from './components/Header/Header.js'
import { RecentlySpotted } from './components/RecentlySpotted/RecentlySpotted.js'
import { RtspVideoViewer } from './components/RtspVideoViewer/RtspVideoViewer.js'
import { useDetections } from './hooks/useDetections.js'
import type { HlsLoader, PlaybackState } from './hooks/useHlsPlayer.js'
import { useViewerCount } from './hooks/useViewerCount.js'
import { readBootstrap } from './lib/bootstrap.js'

export interface AppProps {
  /** Defaults to the config the server templated into the page. */
  bootstrap?: AppBootstrap
  /** Seam for tests — swap in a stub hls.js module. */
  loadHls?: HlsLoader
}

export function App({ bootstrap, loadHls }: AppProps) {
  const config = useMemo(() => bootstrap ?? readBootstrap(), [bootstrap])
  const viewers = useViewerCount()
  const detections = useDetections()
  const [playback, setPlayback] = useState<PlaybackState>('connecting')

  return (
    <>
      <Header title={config.title} isLive={playback === 'playing'} viewers={viewers} />

      <main className="app-main">
        <RtspVideoViewer loadHls={loadHls} onStateChange={setPlayback} />
        <p className="tagline">{config.tagline}</p>
        <RecentlySpotted detections={detections} />
      </main>

      <Footer />
    </>
  )
}
