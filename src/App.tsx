/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from "react";
import { Download, Link as LinkIcon, Play, AlertCircle, CheckCircle2, Loader2, Search, Copy, Check, History, Trash2, ExternalLink, RefreshCw, X, ListOrdered, Pause, PlayCircle, Settings, Gauge } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

interface VideoLink {
  quality: string;
  url: string;
  format: string;
  fps?: number;
  type: "video" | "audio" | "both";
}

interface ExtractionResult {
  title: string;
  thumbnail: string;
  links: VideoLink[];
  url: string;
}

interface HistoryItem {
  title: string;
  thumbnail: string;
  url: string;
  timestamp: number;
}

interface QueueItem {
  id: string;
  title: string;
  res: string;
  url: string;
  filename: string;
  status: 'queued' | 'downloading' | 'paused' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  downloadedSize: number;
  totalSize: number;
  speed: number; // bytes per second
  eta: number; // seconds
  abortController?: AbortController;
}

export default function App() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ExtractionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<string | null>(null);
  const [selectedVariations, setSelectedVariations] = useState<Record<string, number>>({});
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [speedLimit, setSpeedLimit] = useState<number>(0); // 0 means unlimited, in KB/s
  const [showSettings, setShowSettings] = useState(false);
  const [activePlayMenu, setActivePlayMenu] = useState<string | null>(null);
  const [playingVideo, setPlayingVideo] = useState<{ url: string; title: string } | null>(null);

  const speedLimitRef = useRef(speedLimit);
  const chunksRef = useRef<Record<string, Uint8Array[]>>({});
  
  useEffect(() => {
    speedLimitRef.current = speedLimit;
  }, [speedLimit]);

  // Load history from localStorage
  useEffect(() => {
    const savedHistory = localStorage.getItem("vdownloader_history");
    if (savedHistory) {
      try {
        setHistory(JSON.parse(savedHistory));
      } catch (e) {
        console.error("Failed to parse history");
      }
    }
  }, []);

  // Save history to localStorage
  useEffect(() => {
    localStorage.setItem("vdownloader_history", JSON.stringify(history));
  }, [history]);

  const handleExtract = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url) return;

    setLoading(true);
    setError(null);
    setResult(null);
    setCopiedIndex(null);
    setSelectedVariations({});

    try {
      const response = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });

      const data = await response.json();
      if (response.ok) {
        setResult({ ...data, url });
        
        // Add to history
        const newItem: HistoryItem = {
          title: data.title,
          thumbnail: data.thumbnail,
          url: url,
          timestamp: Date.now()
        };
        setHistory(prev => [newItem, ...prev.filter(item => item.url !== url)].slice(0, 20));

        // Initialize selected variations
        const initialVariations: Record<string, number> = {};
        const grouped = groupLinksByResolution(data.links);
        Object.keys(grouped).forEach(res => {
          initialVariations[res] = 0;
        });
        setSelectedVariations(initialVariations);
      } else {
        setError(data.error || "Failed to extract links.");
      }
    } catch (err) {
      setError("An unexpected error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const groupLinksByResolution = (links: VideoLink[]) => {
    const grouped = links.reduce((acc, link) => {
      const resMatch = link.quality.match(/\d+p/);
      const res = resMatch ? resMatch[0] : link.quality;
      if (!acc[res]) acc[res] = [];
      acc[res].push(link);
      return acc;
    }, {} as Record<string, VideoLink[]>);

    // Sort resolutions numerically (descending)
    const sortedKeys = Object.keys(grouped).sort((a, b) => {
      const aNum = parseInt(a) || 0;
      const bNum = parseInt(b) || 0;
      if (aNum !== bNum) return bNum - aNum;
      return a.localeCompare(b);
    });

    const sortedGrouped: Record<string, VideoLink[]> = {};
    sortedKeys.forEach(key => {
      // Sort variations within each resolution: both > video > audio
      sortedGrouped[key] = grouped[key].sort((a, b) => {
        const typeOrder = { both: 0, video: 1, audio: 2 };
        return typeOrder[a.type] - typeOrder[b.type];
      });
    });
    return sortedGrouped;
  };

  const handleCopy = (e: React.MouseEvent, linkUrl: string, res: string) => {
    e.preventDefault();
    e.stopPropagation();
    navigator.clipboard.writeText(linkUrl);
    setCopiedIndex(res);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  // Process Queue
  useEffect(() => {
    const activeDownload = queue.find(item => item.status === 'downloading');
    if (!activeDownload) {
      const nextInQueue = queue.find(item => item.status === 'queued');
      if (nextInQueue) {
        startDownload(nextInQueue.id);
      }
    }
  }, [queue]);

  const addToQueue = (linkUrl: string, filename: string, res: string, title: string) => {
    const id = `${Date.now()}-${res}`;
    const newItem: QueueItem = {
      id,
      title,
      res,
      url: linkUrl,
      filename,
      status: 'queued',
      progress: 0,
      downloadedSize: 0,
      totalSize: 0,
      speed: 0,
      eta: 0
    };
    setQueue(prev => [...prev, newItem]);
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  const formatSpeed = (bytesPerSecond: number) => {
    return formatSize(bytesPerSecond) + "/s";
  };

  const formatETA = (seconds: number) => {
    if (seconds === Infinity || isNaN(seconds)) return "--:--";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const startDownload = async (id: string) => {
    const item = queue.find(i => i.id === id);
    if (!item) return;

    const abortController = new AbortController();
    let startTime = Date.now();
    let lastLoaded = item.downloadedSize || 0;
    let lastTime = startTime;
    let loaded = item.downloadedSize || 0;
    
    // Initialize chunks in ref if not exists
    if (!chunksRef.current[id]) {
      chunksRef.current[id] = [];
    }
    const chunks = chunksRef.current[id];
    
    setQueue(prev => prev.map(i => 
      i.id === id ? { ...i, status: 'downloading', abortController } : i
    ));

    try {
      const fetchOptions: RequestInit = { 
        signal: abortController.signal,
        headers: loaded > 0 ? { 'Range': `bytes=${loaded}-` } : {}
      };

      const response = await fetch(item.url, fetchOptions);
      if (!response.ok && response.status !== 206) throw new Error("Network response was not ok");
      
      const contentLength = response.headers.get("content-length");
      const total = (contentLength ? parseInt(contentLength, 10) : 0) + loaded;
      
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Body reader not available");

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Throttling logic
        const currentLimit = speedLimitRef.current;
        if (currentLimit > 0) {
          const limitBytesPerSec = currentLimit * 1024;
          const elapsed = (Date.now() - startTime) / 1000;
          const expectedTime = (loaded + value.length) / limitBytesPerSec;
          
          if (elapsed < expectedTime) {
            const delay = (expectedTime - elapsed) * 1000;
            await new Promise(resolve => setTimeout(resolve, Math.min(delay, 2000)));
          }
        }

        chunks.push(value);
        loaded += value.length;
        
        const now = Date.now();
        const timeDiff = (now - lastTime) / 1000;
        
        if (timeDiff >= 0.5 || loaded === total) {
          const speed = (loaded - lastLoaded) / timeDiff;
          const remaining = total - loaded;
          const eta = speed > 0 ? remaining / speed : 0;
          const progress = total > 0 ? Math.round((loaded / total) * 100) : 0;

          setQueue(prev => prev.map(i => i.id === id ? { 
            ...i, 
            progress, 
            downloadedSize: loaded, 
            totalSize: total,
            speed,
            eta
          } : i));

          lastLoaded = loaded;
          lastTime = now;
        }
      }

      const blob = new Blob(chunks);
      const downloadUrl = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = downloadUrl;
      a.download = item.filename;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(downloadUrl);
      document.body.removeChild(a);
      
      // Cleanup chunks
      delete chunksRef.current[id];
      
      setQueue(prev => prev.map(i => i.id === id ? { ...i, status: 'completed', progress: 100 } : i));
    } catch (err: any) {
      if (err.name === 'AbortError') {
        setQueue(prev => prev.map(i => {
          if (i.id === id) {
            return i.status === 'paused' ? i : { ...i, status: 'cancelled' };
          }
          return i;
        }));
      } else {
        console.error("Download failed:", err);
        setQueue(prev => prev.map(i => i.id === id ? { ...i, status: 'failed' } : i));
      }
    }
  };

  const pauseDownload = (id: string) => {
    setQueue(prev => prev.map(i => {
      if (i.id === id && i.status === 'downloading') {
        if (i.abortController) i.abortController.abort();
        return { ...i, status: 'paused', speed: 0, eta: 0 };
      }
      return i;
    }));
  };

  const resumeDownload = (id: string) => {
    setQueue(prev => prev.map(i => i.id === id ? { ...i, status: 'queued' } : i));
  };

  const cancelDownload = (id: string) => {
    const item = queue.find(i => i.id === id);
    if (item?.abortController) {
      item.abortController.abort();
    }
    setQueue(prev => prev.filter(i => i.id !== id));
  };

  const removeFromQueue = (id: string) => {
    setQueue(prev => prev.filter(i => i.id !== id));
  };

  const retryDownload = (id: string) => {
    setQueue(prev => prev.map(i => i.id === id ? { ...i, status: 'queued', progress: 0 } : i));
  };

  const handleExternalPlay = (url: string, title: string, player: 'vlc' | 'mx' | 'native' | 'internal') => {
    const encodedUrl = encodeURIComponent(url);
    const encodedTitle = encodeURIComponent(title);

    if (player === 'internal') {
      // Check if it's a YouTube URL and use the embed player if needed
      // However, our backend extracts direct links, so we try direct first
      setPlayingVideo({ url, title });
    } else if (player === 'vlc') {
      window.location.href = `vlc://${url}`;
    } else if (player === 'mx') {
      window.location.href = `intent:${url}#Intent;package=com.mxtech.videoplayer.ad;S.title=${encodedTitle};end`;
    } else {
      // For native player, we use a direct link in a new tab
      const win = window.open(url, '_blank');
      if (!win) {
        // If popup blocked, fallback to internal player
        setPlayingVideo({ url, title });
      }
    }
    setActivePlayMenu(null);
  };

  const clearHistory = () => {
    setHistory([]);
    localStorage.removeItem("vdownloader_history");
  };

  const groupedLinks = result ? groupLinksByResolution(result.links) : {};

  return (
    <div className="min-h-screen bg-[#f5f5f5] text-[#1a1a1a] font-sans selection:bg-[#1a1a1a] selection:text-white">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 py-6 px-4 sticky top-0 z-10 shadow-sm">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="bg-[#1a1a1a] p-2 rounded-lg">
              <Download className="w-6 h-6 text-white" />
            </div>
            <h1 className="text-xl font-bold tracking-tight">Video Downloader Pro</h1>
          </div>
          <div className="hidden sm:flex items-center gap-4 text-xs font-medium uppercase tracking-widest text-gray-400">
            <span>Fast</span>
            <span>•</span>
            <span>Secure</span>
            <span>•</span>
            <span>Universal</span>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-12">
        {/* Search Section */}
        <section className="mb-12">
          <div className="text-center mb-8">
            <h2 className="text-4xl font-light mb-4 tracking-tight">Download your favorite videos.</h2>
            <p className="text-gray-500 max-w-lg mx-auto">
              Support for YouTube, Vimeo, Dailymotion, Instagram, TikTok, Twitter (X), and more.
            </p>
          </div>

          <form onSubmit={handleExtract} className="relative group">
            <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
              <LinkIcon className="h-5 w-5 text-gray-400 group-focus-within:text-[#1a1a1a] transition-colors" />
            </div>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Paste video link here..."
              className="block w-full pl-12 pr-44 py-5 bg-white border border-gray-200 rounded-2xl focus:ring-2 focus:ring-[#1a1a1a] focus:border-transparent transition-all shadow-sm text-lg outline-none"
              required
            />
            <div className="absolute right-2 inset-y-2 flex items-center gap-2">
              {url && (
                <button
                  type="button"
                  onClick={() => {
                    setUrl("");
                    setResult(null);
                  }}
                  className="p-3 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-xl transition-all"
                  title="Clear URL"
                >
                  <X className="w-5 h-5" />
                </button>
              )}
              <button
                type="submit"
                disabled={loading}
                className="px-6 h-full bg-[#1a1a1a] text-white rounded-xl font-medium hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center gap-2"
              >
                {loading ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <>
                    <Search className="w-5 h-5" />
                    <span>Analyze</span>
                  </>
                )}
              </button>
            </div>
          </form>
        </section>

        {/* Results Section */}
        <AnimatePresence mode="wait">
          {error && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="bg-red-50 border border-red-100 p-4 rounded-2xl flex items-start gap-3 text-red-700 mb-8"
            >
              <AlertCircle className="w-5 h-5 mt-0.5 flex-shrink-0" />
              <p className="text-sm font-medium">{error}</p>
            </motion.div>
          )}

          {result && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-8"
            >
              {/* Video Info Card */}
              <div className="bg-white rounded-3xl overflow-hidden border border-gray-200 shadow-sm flex flex-col md:flex-row">
                <div className="md:w-1/3 relative aspect-video md:aspect-auto bg-gray-100">
                  {result.thumbnail ? (
                    <img
                      src={result.thumbnail}
                      alt={result.title}
                      className="w-full h-full object-cover"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-gray-300">
                      <Play className="w-12 h-12" />
                    </div>
                  )}
                  <div className="absolute inset-0 bg-black/10" />
                </div>
                <div className="p-8 md:w-2/3 flex flex-col justify-center">
                  <div className="flex items-center gap-2 text-green-600 mb-2">
                    <CheckCircle2 className="w-4 h-4" />
                    <span className="text-xs font-bold uppercase tracking-widest">Ready to Download</span>
                  </div>
                  <h3 className="text-2xl font-semibold leading-tight mb-4 line-clamp-2">{result.title}</h3>
                  <div className="flex flex-wrap gap-2">
                    <span className="px-3 py-1 bg-gray-100 rounded-full text-xs font-medium text-gray-600">
                      {Object.keys(groupedLinks).length} Resolutions Found
                    </span>
                  </div>
                </div>
              </div>

              {/* Download Options Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {Object.entries(groupedLinks).map(([res, variations], index) => {
                  const selectedIdx = selectedVariations[res] || 0;
                  const selectedLink = variations[selectedIdx] || variations[0];
                  const queueItem = queue.find(item => item.res === res && item.url === selectedLink.url);
                  const formatExt = selectedLink.format || 'mp4';

                  return (
                    <motion.div
                      key={res}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: index * 0.05 }}
                      className="group bg-white p-6 rounded-2xl border border-gray-200 hover:border-[#1a1a1a] hover:shadow-md transition-all flex flex-col gap-4"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <span className="block text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">Resolution</span>
                          <span className="text-xl font-bold group-hover:text-[#1a1a1a] transition-colors">{res}</span>
                        </div>
                        <div className="flex gap-2 relative">
                          <div className="relative">
                            <button
                              onClick={() => setActivePlayMenu(activePlayMenu === res ? null : res)}
                              className={`p-3 rounded-xl transition-all ${activePlayMenu === res ? 'bg-blue-600 text-white' : 'bg-gray-50 hover:bg-blue-50 text-gray-400 hover:text-blue-600'}`}
                              title="Play in Player"
                            >
                              <PlayCircle className="w-5 h-5" />
                            </button>
                            
                            <AnimatePresence>
                              {activePlayMenu === res && (
                                <motion.div
                                  initial={{ opacity: 0, scale: 0.95, y: 10 }}
                                  animate={{ opacity: 1, scale: 1, y: 0 }}
                                  exit={{ opacity: 0, scale: 0.95, y: 10 }}
                                  className="absolute right-0 mt-2 w-48 bg-white rounded-2xl shadow-xl border border-gray-100 py-2 z-20"
                                >
                                  <button
                                    onClick={() => handleExternalPlay(selectedLink.url, result.title, 'internal')}
                                    className="w-full px-4 py-2.5 text-left text-xs font-bold uppercase tracking-widest hover:bg-gray-50 flex items-center gap-3 transition-colors"
                                  >
                                    <div className="w-6 h-6 rounded-lg bg-green-50 flex items-center justify-center">
                                      <Play className="w-3 h-3 text-green-600" />
                                    </div>
                                    Play in App
                                  </button>
                                  <button
                                    onClick={() => handleExternalPlay(selectedLink.url, result.title, 'native')}
                                    className="w-full px-4 py-2.5 text-left text-xs font-bold uppercase tracking-widest hover:bg-gray-50 flex items-center gap-3 transition-colors"
                                  >
                                    <div className="w-6 h-6 rounded-lg bg-blue-50 flex items-center justify-center">
                                      <Play className="w-3 h-3 text-blue-600" />
                                    </div>
                                    Native Player
                                  </button>
                                  <button
                                    onClick={() => handleExternalPlay(selectedLink.url, result.title, 'vlc')}
                                    className="w-full px-4 py-2.5 text-left text-xs font-bold uppercase tracking-widest hover:bg-gray-50 flex items-center gap-3 transition-colors"
                                  >
                                    <div className="w-6 h-6 rounded-lg bg-orange-50 flex items-center justify-center">
                                      <div className="w-3 h-3 bg-orange-500 rounded-sm" />
                                    </div>
                                    Open in VLC
                                  </button>
                                  <button
                                    onClick={() => handleExternalPlay(selectedLink.url, result.title, 'mx')}
                                    className="w-full px-4 py-2.5 text-left text-xs font-bold uppercase tracking-widest hover:bg-gray-50 flex items-center gap-3 transition-colors"
                                  >
                                    <div className="w-6 h-6 rounded-lg bg-blue-50 flex items-center justify-center">
                                      <div className="w-3 h-3 bg-blue-500 rounded-full" />
                                    </div>
                                    Open in MX Player
                                  </button>
                                </motion.div>
                              )}
                            </AnimatePresence>
                          </div>

                          {queueItem?.status === 'failed' ? (
                            <button
                              onClick={() => retryDownload(queueItem.id)}
                              className="bg-red-50 hover:bg-red-100 p-3 rounded-xl transition-colors group/btn text-red-600"
                              title="Retry Download"
                            >
                              <RefreshCw className="w-5 h-5" />
                            </button>
                          ) : (
                            <div className="flex gap-2">
                              <button
                                onClick={() => addToQueue(selectedLink.url, `${result.title}.${formatExt}`, res, result.title)}
                                disabled={queueItem !== undefined && (queueItem.status === 'downloading' || queueItem.status === 'queued')}
                                className="bg-gray-50 hover:bg-[#1a1a1a] p-3 rounded-xl transition-colors group/btn disabled:opacity-50"
                                title="Add to Queue"
                              >
                                {queueItem?.status === 'downloading' ? (
                                  <span className="text-[10px] font-bold text-[#1a1a1a] group-hover/btn:text-white">{queueItem.progress}%</span>
                                ) : queueItem?.status === 'queued' ? (
                                  <Loader2 className="w-5 h-5 text-[#1a1a1a] group-hover/btn:text-white animate-spin" />
                                ) : (
                                  <Download className="w-5 h-5 text-gray-400 group-hover/btn:text-white transition-colors" />
                                )}
                              </button>
                              
                              <a
                                href={selectedLink.url}
                                download={`${result.title}.${formatExt}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="bg-blue-50 hover:bg-blue-600 p-3 rounded-xl transition-colors group/btn"
                                title="Fast Download (Browser Native)"
                              >
                                <Gauge className="w-5 h-5 text-blue-500 group-hover:text-white transition-colors" />
                              </a>
                            </div>
                          )}
                          <a
                            href={selectedLink.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="bg-gray-50 hover:bg-gray-200 p-3 rounded-xl transition-colors text-gray-400 hover:text-[#1a1a1a]"
                            title="Direct Link"
                          >
                            <ExternalLink className="w-5 h-5" />
                          </a>
                        </div>
                      </div>

                      {/* Progress Bar */}
                      {queueItem && (queueItem.status === 'downloading' || queueItem.status === 'failed') && (
                        <div className="w-full h-1 bg-gray-100 rounded-full overflow-hidden">
                          <motion.div 
                            initial={{ width: 0 }}
                            animate={{ width: `${queueItem.progress}%` }}
                            className={`h-full ${queueItem.status === 'failed' ? 'bg-red-500' : 'bg-[#1a1a1a]'}`}
                          />
                        </div>
                      )}

                      {/* Variation Selector */}
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Select Variation</span>
                          <span className="text-[10px] font-medium text-gray-400 bg-gray-50 px-2 py-0.5 rounded">
                            {variations.length} {variations.length === 1 ? 'option' : 'options'}
                          </span>
                        </div>
                        
                        {variations.length > 1 ? (
                          <div className="grid grid-cols-1 gap-2">
                            {variations.length <= 3 ? (
                              <div className="flex flex-col gap-1.5">
                                {variations.map((v, i) => (
                                  <button
                                    key={i}
                                    onClick={() => setSelectedVariations(prev => ({ ...prev, [res]: i }))}
                                    className={`flex items-center justify-between p-3 rounded-xl border transition-all text-left ${
                                      selectedIdx === i 
                                        ? "border-[#1a1a1a] bg-[#1a1a1a] text-white shadow-sm" 
                                        : "border-gray-100 bg-gray-50 text-gray-600 hover:border-gray-200"
                                    }`}
                                  >
                                    <div className="flex flex-col">
                                      <span className="text-xs font-bold uppercase tracking-wider">
                                        {v.format} • {v.type === 'both' ? 'Video + Audio' : v.type === 'video' ? 'Video (No Audio)' : 'Audio Only'}
                                      </span>
                                      {v.fps && <span className={`text-[9px] ${selectedIdx === i ? 'text-gray-300' : 'text-gray-400'}`}>{v.fps} FPS</span>}
                                    </div>
                                    {selectedIdx === i && <CheckCircle2 className="w-4 h-4" />}
                                  </button>
                                ))}
                              </div>
                            ) : (
                              <div className="relative">
                                <select
                                  value={selectedIdx}
                                  onChange={(e) => setSelectedVariations(prev => ({ ...prev, [res]: parseInt(e.target.value) }))}
                                  className="w-full bg-gray-50 border border-gray-100 rounded-xl py-3 px-4 text-xs font-bold focus:ring-1 focus:ring-[#1a1a1a] appearance-none cursor-pointer hover:bg-gray-100 transition-colors"
                                >
                                  {variations.map((v, i) => (
                                    <option key={i} value={i}>
                                      {v.format.toUpperCase()} • {v.type === 'both' ? 'V+A' : v.type === 'video' ? 'Video' : 'Audio'} {v.fps ? `(${v.fps}fps)` : ''}
                                    </option>
                                  ))}
                                </select>
                                <div className="absolute inset-y-0 right-0 flex items-center pr-4 pointer-events-none">
                                  <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
                                  </svg>
                                </div>
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="p-3 bg-gray-50 rounded-xl border border-gray-100 text-center">
                            <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">
                              {selectedLink.format.toUpperCase()} • {selectedLink.type === 'both' ? 'Video+Audio' : selectedLink.type === 'video' ? 'Video Only' : 'Audio Only'}
                            </span>
                          </div>
                        )}
                      </div>
                      
                      <button
                        onClick={(e) => handleCopy(e, selectedLink.url, res)}
                        className="w-full py-2 px-4 bg-gray-50 hover:bg-gray-100 rounded-xl text-xs font-bold uppercase tracking-widest text-gray-500 hover:text-[#1a1a1a] transition-all flex items-center justify-center gap-2"
                      >
                        {copiedIndex === res ? (
                          <>
                            <Check className="w-4 h-4 text-green-600" />
                            <span className="text-green-600">Copied!</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-4 h-4" />
                            <span>Copy Link</span>
                          </>
                        )}
                      </button>
                    </motion.div>
                  );
                })}
              </div>

              {result.links.length === 0 && (
                <div className="text-center py-16 bg-white rounded-3xl border border-dashed border-gray-200 shadow-sm">
                  <div className="w-16 h-16 bg-gray-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
                    <AlertCircle className="w-8 h-8 text-gray-300" />
                  </div>
                  <h3 className="text-xl font-bold mb-2">No Direct Links Found</h3>
                  <p className="text-gray-400 max-w-xs mx-auto mb-6">
                    We couldn't find any direct download links for this URL. The site might be protected or the video is private.
                  </p>
                  <button 
                    onClick={() => setUrl("")}
                    className="px-6 py-3 bg-[#1a1a1a] text-white rounded-xl font-bold text-sm uppercase tracking-widest hover:bg-gray-800 transition-all"
                  >
                    Try Another URL
                  </button>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Supported Platforms */}
        {!result && !loading && (
          <section className="mt-24">
            <div className="text-center mb-12">
              <span className="text-[10px] font-bold text-gray-400 uppercase tracking-[0.2em] mb-4 block">Compatibility</span>
              <h2 className="text-2xl font-bold tracking-tight">Supported Platforms</h2>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[
                { name: 'YouTube', icon: 'YT' },
                { name: 'Instagram', icon: 'IG' },
                { name: 'TikTok', icon: 'TT' },
                { name: 'Facebook', icon: 'FB' },
                { name: 'Twitter (X)', icon: 'TW' },
                { name: 'Vimeo', icon: 'VM' },
                { name: 'Dailymotion', icon: 'DM' },
                { name: 'And More...', icon: '∞' }
              ].map((site) => (
                <div key={site.name} className="bg-white p-6 rounded-2xl border border-gray-100 flex flex-col items-center gap-3 hover:border-[#1a1a1a] transition-all group">
                  <div className="w-12 h-12 rounded-xl bg-gray-50 flex items-center justify-center text-lg font-black text-gray-300 group-hover:text-[#1a1a1a] transition-colors">
                    {site.icon}
                  </div>
                  <span className="text-xs font-bold text-gray-500">{site.name}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Download Queue Section */}
        {queue.length > 0 && (
          <section className="mt-12 bg-white rounded-3xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="p-6 border-b border-gray-100 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ListOrdered className="w-5 h-5" />
                <h2 className="text-lg font-bold">Download Queue</h2>
              </div>
              <div className="flex items-center gap-4">
                <button 
                  onClick={() => setShowSettings(!showSettings)}
                  className={`p-2 rounded-lg transition-all ${showSettings ? 'bg-[#1a1a1a] text-white' : 'hover:bg-gray-100 text-gray-400'}`}
                  title="Queue Settings"
                >
                  <Settings className="w-4 h-4" />
                </button>
                <span className="text-xs font-bold text-gray-400 uppercase tracking-widest">
                  {queue.filter(i => i.status === 'downloading').length} Active • {queue.filter(i => i.status === 'queued').length} Queued
                </span>
              </div>
            </div>

            <AnimatePresence>
              {showSettings && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="bg-gray-50 border-b border-gray-100 overflow-hidden"
                >
                  <div className="p-6">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div className="flex items-center gap-3">
                        <div className="p-2 bg-white rounded-lg shadow-sm">
                          <Gauge className="w-4 h-4 text-[#1a1a1a]" />
                        </div>
                        <div>
                          <h3 className="text-sm font-bold">Speed Limit</h3>
                          <p className="text-[10px] text-gray-400 uppercase tracking-widest">Throttle download speed</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <input 
                          type="range"
                          min="0"
                          max="10240" // 10MB/s
                          step="128"
                          value={speedLimit}
                          onChange={(e) => setSpeedLimit(parseInt(e.target.value))}
                          className="w-48 h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-[#1a1a1a]"
                        />
                        <div className="min-w-[80px] text-right">
                          <span className="text-sm font-bold">{speedLimit === 0 ? 'Unlimited' : formatSpeed(speedLimit * 1024)}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="divide-y divide-gray-50 max-h-[400px] overflow-y-auto">
              <AnimatePresence initial={false}>
                {queue.map((item) => (
                  <motion.div
                    key={item.id}
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="p-4 flex items-center gap-4 group"
                  >
                    <div className="w-10 h-10 rounded-xl bg-gray-50 flex items-center justify-center flex-shrink-0">
                      {item.status === 'downloading' ? (
                        <Loader2 className="w-5 h-5 text-[#1a1a1a] animate-spin" />
                      ) : item.status === 'completed' ? (
                        <CheckCircle2 className="w-5 h-5 text-green-500" />
                      ) : item.status === 'failed' ? (
                        <AlertCircle className="w-5 h-5 text-red-500" />
                      ) : (
                        <Pause className="w-5 h-5 text-gray-300" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <h4 className="text-sm font-bold truncate">{item.title}</h4>
                          <span className="text-[10px] font-bold text-gray-400 bg-gray-50 px-1.5 py-0.5 rounded uppercase tracking-widest flex-shrink-0">{item.res}</span>
                        </div>
                        <div className="flex items-center gap-3 flex-shrink-0">
                          {item.status === 'downloading' && (
                            <div className="flex items-center gap-2 text-[10px] font-bold text-gray-400">
                              <span>{formatSpeed(item.speed)}</span>
                              <span className="w-1 h-1 bg-gray-200 rounded-full" />
                              <span>{formatETA(item.eta)} left</span>
                            </div>
                          )}
                          <span className="text-[10px] font-bold text-gray-500">{item.progress}%</span>
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <div className="relative w-full h-2 bg-gray-100 rounded-full overflow-hidden">
                          {/* Simulated Buffer Bar (slightly ahead of progress) */}
                          {item.status === 'downloading' && (
                            <motion.div 
                              initial={{ width: 0 }}
                              animate={{ width: `${Math.min(item.progress + 5, 100)}%` }}
                              className="absolute inset-y-0 left-0 bg-gray-200/50 transition-all duration-500"
                            />
                          )}
                          <motion.div 
                            initial={{ width: 0 }}
                            animate={{ width: `${item.progress}%` }}
                            className={`absolute inset-y-0 left-0 h-full transition-all duration-300 ${
                              item.status === 'failed' ? 'bg-red-500' : 
                              item.status === 'completed' ? 'bg-green-500' : 
                              'bg-[#1a1a1a]'
                            }`}
                          >
                            {item.status === 'downloading' && (
                              <motion.div 
                                animate={{ x: ['0%', '100%'], opacity: [0, 1, 0] }}
                                transition={{ repeat: Infinity, duration: 1.5, ease: "linear" }}
                                className="absolute inset-y-0 w-20 bg-gradient-to-r from-transparent via-white/30 to-transparent"
                              />
                            )}
                          </motion.div>
                        </div>
                        {item.status === 'downloading' && (
                          <div className="flex justify-between text-[9px] font-bold text-gray-400 uppercase tracking-tighter">
                            <span>{formatSize(item.downloadedSize)}</span>
                            <span>{formatSize(item.totalSize)}</span>
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      {item.status === 'downloading' && (
                        <button 
                          onClick={() => pauseDownload(item.id)}
                          className="p-2 hover:bg-blue-50 rounded-lg text-gray-400 hover:text-blue-600"
                          title="Pause"
                        >
                          <Pause className="w-4 h-4" />
                        </button>
                      )}
                      {item.status === 'paused' && (
                        <button 
                          onClick={() => resumeDownload(item.id)}
                          className="p-2 hover:bg-green-50 rounded-lg text-gray-400 hover:text-green-600"
                          title="Resume"
                        >
                          <Play className="w-4 h-4" />
                        </button>
                      )}
                      {item.status === 'failed' && (
                        <button 
                          onClick={() => retryDownload(item.id)}
                          className="p-2 hover:bg-gray-100 rounded-lg text-gray-400 hover:text-[#1a1a1a]"
                        >
                          <RefreshCw className="w-4 h-4" />
                        </button>
                      )}
                      {(item.status === 'downloading' || item.status === 'queued' || item.status === 'paused') && (
                        <button 
                          onClick={() => cancelDownload(item.id)}
                          className="p-2 hover:bg-red-50 rounded-lg text-gray-400 hover:text-red-500"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      )}
                      {(item.status === 'completed' || item.status === 'cancelled') && (
                        <button 
                          onClick={() => removeFromQueue(item.id)}
                          className="p-2 hover:bg-gray-100 rounded-lg text-gray-400 hover:text-[#1a1a1a]"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </section>
        )}

        {/* History Section */}
        {history.length > 0 && (
          <section className="mt-24">
            <div className="flex items-center justify-between mb-8">
              <div className="flex items-center gap-2">
                <History className="w-5 h-5" />
                <h2 className="text-xl font-bold tracking-tight">Recent Downloads</h2>
              </div>
              <button 
                onClick={clearHistory}
                className="text-xs font-bold uppercase tracking-widest text-gray-400 hover:text-red-500 transition-colors flex items-center gap-2"
              >
                <Trash2 className="w-4 h-4" />
                Clear All
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {history.map((item, idx) => (
                <motion.div
                  key={item.timestamp}
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: idx * 0.05 }}
                  className="bg-white p-4 rounded-2xl border border-gray-200 flex gap-4 group cursor-pointer hover:border-[#1a1a1a] transition-all"
                  onClick={() => {
                    setUrl(item.url);
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                >
                  <div className="w-24 h-16 rounded-lg overflow-hidden flex-shrink-0 bg-gray-100">
                    {item.thumbnail ? (
                      <img src={item.thumbnail} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-gray-300">
                        <Play className="w-6 h-6" />
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0 flex flex-col justify-center">
                    <h4 className="text-sm font-bold truncate group-hover:text-[#1a1a1a] transition-colors">{item.title}</h4>
                    <p className="text-[10px] text-gray-400 mt-1 uppercase tracking-widest">
                      {new Date(item.timestamp).toLocaleDateString()} • {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </p>
                  </div>
                  <div className="flex items-center pr-2">
                    <Search className="w-4 h-4 text-gray-300 group-hover:text-[#1a1a1a] transition-colors" />
                  </div>
                </motion.div>
              ))}
            </div>
          </section>
        )}
      </main>

      {/* Internal Video Player Modal */}
      <AnimatePresence>
        {playingVideo && (
          <VideoPlayer 
            url={playingVideo.url} 
            title={playingVideo.title} 
            onClose={() => setPlayingVideo(null)} 
          />
        )}
      </AnimatePresence>

      {/* Footer */}
      <footer className="mt-24 border-t border-gray-200 py-12 px-4">
        <div className="max-w-4xl mx-auto text-center">
          <p className="text-gray-400 text-sm">
            © 2026 Video Downloader Pro. Built for speed and simplicity.
          </p>
          <div className="mt-4 flex justify-center gap-6 text-xs font-medium text-gray-400 uppercase tracking-widest">
            <a href="#" className="hover:text-[#1a1a1a] transition-colors">Privacy</a>
            <a href="#" className="hover:text-[#1a1a1a] transition-colors">Terms</a>
            <a href="#" className="hover:text-[#1a1a1a] transition-colors">Contact</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function VideoPlayer({ url, title, onClose }: { url: string; title: string; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4 md:p-8"
    >
      <div className="relative w-full max-w-5xl bg-black rounded-3xl overflow-hidden shadow-2xl aspect-video flex items-center justify-center">
        <div className="absolute top-0 left-0 right-0 p-4 bg-gradient-to-b from-black/80 to-transparent z-20 flex items-center justify-between">
          <h3 className="text-white font-bold truncate pr-8">{title}</h3>
          <button
            onClick={onClose}
            className="p-2 bg-white/10 hover:bg-white/20 rounded-full text-white transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </div>
        
        {loading && !error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 z-10">
            <Loader2 className="w-10 h-10 text-white animate-spin" />
            <p className="text-white/60 text-xs font-bold uppercase tracking-widest">Loading Preview...</p>
          </div>
        )}

        {error ? (
          <div className="flex flex-col items-center justify-center gap-4 p-8 text-center">
            <div className="w-16 h-16 bg-red-500/10 rounded-2xl flex items-center justify-center">
              <AlertCircle className="w-8 h-8 text-red-500" />
            </div>
            <div className="space-y-2">
              <h3 className="text-white font-bold">Playback Error</h3>
              <p className="text-white/60 text-sm max-w-xs">{error}</p>
            </div>
            <button 
              onClick={() => window.open(url, '_blank')}
              className="mt-4 px-6 py-3 bg-white text-black rounded-xl font-bold text-xs uppercase tracking-widest hover:bg-gray-200 transition-all flex items-center gap-2"
            >
              <ExternalLink className="w-4 h-4" />
              Open in New Tab
            </button>
          </div>
        ) : (
          <video
            src={url}
            controls
            autoPlay
            className="w-full h-full object-contain"
            onLoadedData={() => setLoading(false)}
            onError={() => {
              setLoading(false);
              setError("This video format might not be supported by your browser or the link has expired.");
            }}
            referrerPolicy="no-referrer"
          />
        )}
      </div>
    </motion.div>
  );
}
