/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
import { 
  Download, Link as LinkIcon, Play, AlertCircle, CheckCircle2, 
  Loader2, Search, Copy, Check, History, Trash2, ExternalLink, 
  RefreshCw, X, ListOrdered, Pause, PlayCircle, Settings, 
  Gauge, Moon, Sun, Clipboard, Share2, FolderOpen, Info,
  Youtube, Instagram, Facebook, Twitter, Music, Video, ChevronDown
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

interface VideoLink {
  quality: string;
  url: string;
  format: string;
  fps?: number;
  type: "video" | "audio" | "both";
  size?: number;
}

interface ExtractionResult {
  title: string;
  thumbnail: string;
  links: VideoLink[];
  url: string;
}

interface HistoryItem {
  id: string;
  title: string;
  thumbnail: string;
  url: string;
  timestamp: number;
  filename?: string;
  quality?: string;
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
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const speedLimitRef = useRef(speedLimit);
  const chunksRef = useRef<Record<string, Uint8Array[]>>({});
  
  useEffect(() => {
    speedLimitRef.current = speedLimit;
  }, [speedLimit]);

  // Dark mode initialization
  useEffect(() => {
    const savedTheme = localStorage.getItem("vdownloader_theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    
    if (savedTheme === "dark" || (!savedTheme && prefersDark)) {
      setIsDarkMode(true);
      document.documentElement.classList.add("dark");
    }
  }, []);

  const toggleDarkMode = () => {
    setIsDarkMode(prev => {
      const next = !prev;
      if (next) {
        document.documentElement.classList.add("dark");
        localStorage.setItem("vdownloader_theme", "dark");
      } else {
        document.documentElement.classList.remove("dark");
        localStorage.setItem("vdownloader_theme", "light");
      }
      return next;
    });
  };

  // Load history from localStorage
  useEffect(() => {
    const savedHistory = localStorage.getItem("vdownloader_history_v2");
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
    localStorage.setItem("vdownloader_history_v2", JSON.stringify(history));
  }, [history]);

  const handleExtract = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
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
        
        // Initialize selected variations
        const initialVariations: Record<string, number> = {};
        const grouped = groupLinksByResolution(data.links);
        Object.keys(grouped).forEach(res => {
          initialVariations[res] = 0;
        });
        setSelectedVariations(initialVariations);
      } else {
        setError(data.error || "Failed to extract links. Please check the URL.");
      }
    } catch (err) {
      setError("An unexpected error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      setUrl(text);
    } catch (err) {
      console.error("Failed to read clipboard", err);
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

    const sortedKeys = Object.keys(grouped).sort((a, b) => {
      const aNum = parseInt(a) || 0;
      const bNum = parseInt(b) || 0;
      if (aNum !== bNum) return bNum - aNum;
      return a.localeCompare(b);
    });

    const sortedGrouped: Record<string, VideoLink[]> = {};
    sortedKeys.forEach(key => {
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

  const addToQueue = (linkUrl: string, filename: string, res: string, title: string, thumbnail: string) => {
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

    // Add to history
    const historyItem: HistoryItem = {
      id,
      title,
      thumbnail,
      url: result?.url || "",
      timestamp: Date.now(),
      filename,
      quality: res
    };
    setHistory(prev => [historyItem, ...prev.filter(item => item.url !== result?.url)].slice(0, 50));
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
    
    if (!chunksRef.current[id]) {
      chunksRef.current[id] = [];
    }
    const chunks = chunksRef.current[id];
    
    setQueue(prev => prev.map(i => 
      i.id === id ? { ...i, status: 'downloading', abortController } : i
    ));

    try {
      const response = await fetch(item.url, { 
        signal: abortController.signal,
        headers: loaded > 0 ? { 'Range': `bytes=${loaded}-` } : {}
      });
      
      if (!response.ok && response.status !== 206) throw new Error("Network response was not ok");
      
      const contentLength = response.headers.get("content-length");
      const total = (contentLength ? parseInt(contentLength, 10) : 0) + loaded;
      
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Body reader not available");

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const currentLimit = speedLimitRef.current;
        if (currentLimit > 0) {
          const limitBytesPerSec = currentLimit * 1024;
          const elapsed = (Date.now() - startTime) / 1000;
          const expectedTime = (loaded + value.length) / limitBytesPerSec;
          if (elapsed < expectedTime) {
            await new Promise(resolve => setTimeout(resolve, (expectedTime - elapsed) * 1000));
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
      
      delete chunksRef.current[id];
      setQueue(prev => prev.map(i => i.id === id ? { ...i, status: 'completed', progress: 100 } : i));
    } catch (err: any) {
      if (err.name === 'AbortError') {
        setQueue(prev => prev.map(i => i.id === id ? (i.status === 'paused' ? i : { ...i, status: 'cancelled' }) : i));
      } else {
        setQueue(prev => prev.map(i => i.id === id ? { ...i, status: 'failed' } : i));
      }
    }
  };

  const pauseDownload = (id: string) => {
    setQueue(prev => prev.map(i => {
      if (i.id === id && i.status === 'downloading') {
        i.abortController?.abort();
        return { ...i, status: 'paused', speed: 0, eta: 0 };
      }
      return i;
    }));
  };

  const resumeDownload = (id: string) => {
    setQueue(prev => prev.map(i => i.id === id ? { ...i, status: 'queued' } : i));
  };

  const cancelDownload = (id: string) => {
    queue.find(i => i.id === id)?.abortController?.abort();
    setQueue(prev => prev.filter(i => i.id !== id));
  };

  const handleExternalPlay = (url: string, title: string, player: 'vlc' | 'mx' | 'native' | 'internal') => {
    if (player === 'internal') {
      setPlayingVideo({ url, title });
    } else if (player === 'vlc') {
      window.location.href = `vlc://${url}`;
    } else if (player === 'mx') {
      window.location.href = `intent:${url}#Intent;package=com.mxtech.videoplayer.ad;S.title=${encodeURIComponent(title)};end`;
    } else {
      const win = window.open(url, '_blank');
      if (!win) setPlayingVideo({ url, title });
    }
    setActivePlayMenu(null);
  };

  const handleShare = async (title: string, url: string) => {
    if (navigator.share) {
      try {
        await navigator.share({ title, text: `Check out this video: ${title}`, url });
      } catch (err) {
        console.error("Error sharing", err);
      }
    } else {
      navigator.clipboard.writeText(url);
      alert("Link copied to clipboard!");
    }
  };

  const clearHistory = () => {
    if (confirm("Clear all download history?")) {
      setHistory([]);
      localStorage.removeItem("vdownloader_history_v2");
    }
  };

  const groupedLinks = result ? groupLinksByResolution(result.links) : {};

  return (
    <div className="min-h-screen bg-background text-foreground selection:bg-primary selection:text-white">
      {/* Header */}
      <header className="glass sticky top-0 z-40 py-4 px-4 border-b">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <motion.div 
              whileHover={{ rotate: 10, scale: 1.1 }}
              className="orange-gradient p-2.5 rounded-2xl orange-glow"
            >
              <Download className="w-6 h-6 text-white" />
            </motion.div>
            <div>
              <h1 className="text-xl font-extrabold tracking-tight leading-none">Video Downloader</h1>
              <span className="text-[10px] font-bold text-primary uppercase tracking-[0.2em]">Pro Edition</span>
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            <button 
              onClick={() => setShowHistory(!showHistory)}
              className="p-2.5 rounded-xl hover:bg-muted transition-colors relative"
              title="History"
            >
              <History className="w-5 h-5" />
              {history.length > 0 && (
                <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-primary rounded-full border-2 border-background" />
              )}
            </button>
            <button 
              onClick={toggleDarkMode}
              className="p-2.5 rounded-xl hover:bg-muted transition-colors"
              title="Toggle Theme"
            >
              {isDarkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-10 md:py-16">
        {/* Hero Section */}
        <section className="text-center mb-12 md:mb-20">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <h2 className="text-4xl md:text-6xl font-extrabold mb-6 tracking-tight leading-tight">
              Download <span className="text-primary">Anything</span>,<br />
              Anywhere.
            </h2>
            <p className="text-muted-foreground max-w-xl mx-auto text-lg mb-10">
              The ultimate universal video downloader. Fast, secure, and completely free.
            </p>
          </motion.div>

          {/* Search Box */}
          <div className="max-w-2xl mx-auto">
            <form onSubmit={handleExtract} className="relative group">
              <div className="absolute inset-y-0 left-0 pl-5 flex items-center pointer-events-none">
                <LinkIcon className="h-5 w-5 text-muted-foreground group-focus-within:text-primary transition-colors" />
              </div>
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="Paste video link here..."
                className="block w-full pl-14 pr-40 py-6 bg-card border-2 border-muted rounded-3xl focus:ring-4 focus:ring-primary/10 focus:border-primary transition-all shadow-xl text-lg outline-none"
                required
              />
              <div className="absolute right-3 inset-y-3 flex items-center gap-2">
                {url ? (
                  <button
                    type="button"
                    onClick={() => { setUrl(""); setResult(null); }}
                    className="p-3 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-2xl transition-all"
                  >
                    <X className="w-5 h-5" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handlePaste}
                    className="p-3 text-muted-foreground hover:text-primary hover:bg-primary/10 rounded-2xl transition-all"
                    title="Paste from clipboard"
                  >
                    <Clipboard className="w-5 h-5" />
                  </button>
                )}
                <button
                  type="submit"
                  disabled={loading}
                  className="px-6 h-full bg-primary text-white rounded-2xl font-bold hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center gap-2 shadow-lg shadow-primary/20"
                >
                  {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Search className="w-5 h-5" />}
                  <span className="hidden sm:inline">Analyze</span>
                </button>
              </div>
            </form>
          </div>
        </section>

        {/* Results Section */}
        <AnimatePresence mode="wait">
          {error && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="max-w-2xl mx-auto bg-destructive/10 border border-destructive/20 p-5 rounded-3xl flex items-start gap-4 text-destructive mb-10"
            >
              <AlertCircle className="w-6 h-6 mt-0.5 flex-shrink-0" />
              <div>
                <h4 className="font-bold">Extraction Failed</h4>
                <p className="text-sm opacity-90">{error}</p>
              </div>
            </motion.div>
          )}

          {result && (
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-10"
            >
              {/* Video Info Card */}
              <div className="bg-card rounded-[2.5rem] overflow-hidden border shadow-2xl flex flex-col md:flex-row">
                <div className="md:w-2/5 relative aspect-video md:aspect-auto bg-muted">
                  {result.thumbnail ? (
                    <img
                      src={result.thumbnail}
                      alt={result.title}
                      className="w-full h-full object-cover"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-muted-foreground">
                      <Play className="w-16 h-16 opacity-20" />
                    </div>
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent md:bg-black/5" />
                  <div className="absolute bottom-4 left-4 right-4 md:hidden">
                    <h3 className="text-white font-bold line-clamp-2 drop-shadow-md">{result.title}</h3>
                  </div>
                </div>
                <div className="p-8 md:p-10 md:w-3/5 flex flex-col justify-center">
                  <div className="hidden md:block">
                    <div className="flex items-center gap-2 text-primary mb-3">
                      <CheckCircle2 className="w-5 h-5" />
                      <span className="text-xs font-black uppercase tracking-[0.2em]">Ready to Download</span>
                    </div>
                    <h3 className="text-3xl font-extrabold leading-tight mb-6 line-clamp-2">{result.title}</h3>
                  </div>
                  
                  <div className="flex flex-wrap gap-3">
                    <div className="flex items-center gap-2 px-4 py-2 bg-muted rounded-2xl text-xs font-bold">
                      <Video className="w-4 h-4 text-primary" />
                      {Object.keys(groupedLinks).length} Resolutions
                    </div>
                    <button 
                      onClick={() => handleShare(result.title, result.url)}
                      className="flex items-center gap-2 px-4 py-2 bg-primary/10 text-primary hover:bg-primary/20 rounded-2xl text-xs font-bold transition-colors"
                    >
                      <Share2 className="w-4 h-4" />
                      Share Video
                    </button>
                  </div>
                </div>
              </div>

              {/* Download Options Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                {Object.entries(groupedLinks).map(([res, variations], idx) => {
                  const selectedIdx = selectedVariations[res] || 0;
                  const selectedLink = variations[selectedIdx] || variations[0];
                  const queueItem = queue.find(item => item.res === res && item.url === selectedLink.url);
                  const formatExt = selectedLink.format || 'mp4';

                  return (
                    <motion.div
                      key={res}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: idx * 0.05 }}
                      className="group bg-card p-6 rounded-[2rem] border hover:border-primary hover:shadow-2xl hover:shadow-primary/5 transition-all flex flex-col gap-6"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <span className="block text-[10px] font-black text-muted-foreground uppercase tracking-[0.2em] mb-1">Resolution</span>
                          <span className="text-2xl font-black group-hover:text-primary transition-colors">{res}</span>
                        </div>
                        <div className="flex gap-2 relative">
                          <button
                            onClick={() => setActivePlayMenu(activePlayMenu === res ? null : res)}
                            className={`p-3 rounded-2xl transition-all ${activePlayMenu === res ? 'bg-primary text-white' : 'bg-muted hover:bg-primary/10 text-muted-foreground hover:text-primary'}`}
                          >
                            <PlayCircle className="w-5 h-5" />
                          </button>
                          
                          <AnimatePresence>
                            {activePlayMenu === res && (
                              <motion.div
                                initial={{ opacity: 0, scale: 0.9, y: 10 }}
                                animate={{ opacity: 1, scale: 1, y: 0 }}
                                exit={{ opacity: 0, scale: 0.9, y: 10 }}
                                className="absolute right-0 mt-14 w-52 glass rounded-3xl shadow-2xl py-3 z-50 overflow-hidden"
                              >
                                {[
                                  { id: 'internal', label: 'Play in App', icon: Play, color: 'text-orange-500' },
                                  { id: 'native', label: 'Native Player', icon: ExternalLink, color: 'text-blue-500' },
                                  { id: 'vlc', label: 'Open in VLC', icon: Video, color: 'text-orange-600' }
                                ].map(p => (
                                  <button
                                    key={p.id}
                                    onClick={() => handleExternalPlay(selectedLink.url, result.title, p.id as any)}
                                    className="w-full px-5 py-3 text-left text-[10px] font-black uppercase tracking-widest hover:bg-primary/5 flex items-center gap-4 transition-colors"
                                  >
                                    <p.icon className={`w-4 h-4 ${p.color}`} />
                                    {p.label}
                                  </button>
                                ))}
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>
                      </div>

                      {/* Variation Selector */}
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-black text-muted-foreground uppercase tracking-widest">Format & Type</span>
                          <span className="text-[10px] font-bold text-primary bg-primary/10 px-2 py-0.5 rounded-lg">
                            {variations.length} Options
                          </span>
                        </div>
                        
                        <div className="relative">
                          <select
                            value={selectedIdx}
                            onChange={(e) => setSelectedVariations(prev => ({ ...prev, [res]: parseInt(e.target.value) }))}
                            className="w-full bg-muted border-none rounded-2xl py-3.5 px-5 text-xs font-bold focus:ring-2 focus:ring-primary appearance-none cursor-pointer hover:bg-muted/80 transition-colors"
                          >
                            {variations.map((v, i) => (
                              <option key={i} value={i}>
                                {v.format.toUpperCase()} • {v.type === 'both' ? 'Video+Audio' : v.type === 'video' ? 'Video Only' : 'Audio Only'} {v.fps ? `(${v.fps}fps)` : ''}
                              </option>
                            ))}
                          </select>
                          <ChevronDown className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                        </div>
                      </div>

                      <div className="mt-auto pt-4 flex gap-3">
                        <button
                          onClick={() => addToQueue(selectedLink.url, `${result.title}.${formatExt}`, res, result.title, result.thumbnail)}
                          disabled={queueItem !== undefined && (queueItem.status === 'downloading' || queueItem.status === 'queued')}
                          className="flex-1 py-4 bg-primary text-white rounded-2xl font-black text-[10px] uppercase tracking-[0.2em] hover:bg-primary-hover disabled:opacity-50 transition-all flex items-center justify-center gap-3 shadow-lg shadow-primary/20"
                        >
                          {queueItem?.status === 'downloading' ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : <Download className="w-4 h-4" />}
                          {queueItem?.status === 'downloading' ? `${queueItem.progress}%` : 'Download'}
                        </button>
                        
                        <button
                          onClick={(e) => handleCopy(e, selectedLink.url, res)}
                          className="p-4 bg-muted hover:bg-primary/10 text-muted-foreground hover:text-primary rounded-2xl transition-all"
                          title="Copy Link"
                        >
                          {copiedIndex === res ? <Check className="w-5 h-5 text-green-500" /> : <Copy className="w-5 h-5" />}
                        </button>
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Features Grid */}
        {!result && !loading && (
          <section className="mt-20">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
              {[
                { title: 'Multi-Platform', desc: 'Support for YouTube, Instagram, Facebook, Twitter and more.', icon: Youtube },
                { title: 'High Quality', desc: 'Download in 4K, 1080p, 720p or extract high-quality MP3 audio.', icon: Video },
                { title: 'Fast & Secure', desc: 'Lightning fast extraction with no ads or tracking.', icon: Gauge }
              ].map((f, i) => (
                <motion.div 
                  key={i}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 + i * 0.1 }}
                  className="bg-card p-8 rounded-[2rem] border hover:border-primary transition-all group"
                >
                  <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                    <f.icon className="w-7 h-7 text-primary" />
                  </div>
                  <h3 className="text-xl font-extrabold mb-3">{f.title}</h3>
                  <p className="text-muted-foreground text-sm leading-relaxed">{f.desc}</p>
                </motion.div>
              ))}
            </div>
          </section>
        )}

        {/* Download Queue */}
        <AnimatePresence>
          {queue.length > 0 && (
            <motion.section 
              initial={{ opacity: 0, y: 40 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-16 bg-card rounded-[2.5rem] border shadow-2xl overflow-hidden"
            >
              <div className="p-8 border-b flex items-center justify-between bg-muted/30">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-primary rounded-xl">
                    <ListOrdered className="w-5 h-5 text-white" />
                  </div>
                  <h2 className="text-xl font-extrabold">Active Downloads</h2>
                </div>
                <button 
                  onClick={() => setShowSettings(!showSettings)}
                  className={`p-2.5 rounded-xl transition-all ${showSettings ? 'bg-primary text-white' : 'hover:bg-muted text-muted-foreground'}`}
                >
                  <Settings className="w-5 h-5" />
                </button>
              </div>

              {showSettings && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="bg-muted/20 border-b p-8"
                >
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-6">
                    <div className="flex items-center gap-4">
                      <div className="p-3 bg-card rounded-2xl shadow-sm">
                        <Gauge className="w-5 h-5 text-primary" />
                      </div>
                      <div>
                        <h3 className="font-bold">Speed Throttle</h3>
                        <p className="text-[10px] text-muted-foreground font-black uppercase tracking-widest">Limit download speed</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-6">
                      <input 
                        type="range" min="0" max="10240" step="128"
                        value={speedLimit}
                        onChange={(e) => setSpeedLimit(parseInt(e.target.value))}
                        className="w-48 h-2 bg-muted rounded-full appearance-none cursor-pointer accent-primary"
                      />
                      <span className="min-w-[100px] text-right font-black text-sm">
                        {speedLimit === 0 ? 'UNLIMITED' : `${speedLimit} KB/s`}
                      </span>
                    </div>
                  </div>
                </motion.div>
              )}

              <div className="divide-y max-h-[500px] overflow-y-auto no-scrollbar">
                {queue.map((item) => (
                  <div key={item.id} className="p-6 flex items-center gap-6 group hover:bg-muted/10 transition-colors">
                    <div className="w-14 h-14 rounded-2xl bg-muted flex items-center justify-center flex-shrink-0 relative overflow-hidden">
                      {item.status === 'downloading' ? (
                        <Loader2 className="w-6 h-6 text-primary animate-spin" />
                      ) : item.status === 'completed' ? (
                        <CheckCircle2 className="w-6 h-6 text-green-500" />
                      ) : item.status === 'failed' ? (
                        <AlertCircle className="w-6 h-6 text-destructive" />
                      ) : <Pause className="w-6 h-6 text-muted-foreground" />}
                      
                      {/* Mini progress background */}
                      <div 
                        className="absolute bottom-0 left-0 right-0 bg-primary/10 transition-all duration-500" 
                        style={{ height: `${item.progress}%` }} 
                      />
                    </div>
                    
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-3 min-w-0">
                          <h4 className="font-bold truncate text-sm">{item.title}</h4>
                          <span className="text-[9px] font-black text-primary bg-primary/10 px-2 py-0.5 rounded-lg uppercase tracking-widest">{item.res}</span>
                        </div>
                        <span className="text-xs font-black text-primary">{item.progress}%</span>
                      </div>
                      
                      <div className="space-y-2">
                        <div className="w-full h-2.5 bg-muted rounded-full overflow-hidden relative">
                          <motion.div 
                            initial={{ width: 0 }}
                            animate={{ width: `${item.progress}%` }}
                            className={`h-full rounded-full transition-all duration-300 ${
                              item.status === 'failed' ? 'bg-destructive' : 
                              item.status === 'completed' ? 'bg-green-500' : 
                              'orange-gradient'
                            }`}
                          />
                        </div>
                        {item.status === 'downloading' && (
                          <div className="flex justify-between text-[9px] font-black text-muted-foreground uppercase tracking-widest">
                            <div className="flex gap-3">
                              <span>{formatSize(item.downloadedSize)} / {formatSize(item.totalSize)}</span>
                              <span className="text-primary">{formatSpeed(item.speed)}</span>
                            </div>
                            <span>{formatETA(item.eta)} remaining</span>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex gap-2">
                      {item.status === 'downloading' ? (
                        <button onClick={() => pauseDownload(item.id)} className="p-3 hover:bg-primary/10 rounded-2xl text-muted-foreground hover:text-primary transition-all">
                          <Pause className="w-5 h-5" />
                        </button>
                      ) : item.status === 'paused' ? (
                        <button onClick={() => resumeDownload(item.id)} className="p-3 hover:bg-green-500/10 rounded-2xl text-muted-foreground hover:text-green-500 transition-all">
                          <Play className="w-5 h-5" />
                        </button>
                      ) : null}
                      <button onClick={() => cancelDownload(item.id)} className="p-3 hover:bg-destructive/10 rounded-2xl text-muted-foreground hover:text-destructive transition-all">
                        <X className="w-5 h-5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </motion.section>
          )}
        </AnimatePresence>

        {/* History Drawer/Section */}
        <AnimatePresence>
          {showHistory && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-4"
              onClick={() => setShowHistory(false)}
            >
              <motion.div
                initial={{ y: "100%" }}
                animate={{ y: 0 }}
                exit={{ y: "100%" }}
                className="w-full max-w-2xl bg-card rounded-t-[2.5rem] sm:rounded-[2.5rem] shadow-2xl max-h-[85vh] flex flex-col overflow-hidden"
                onClick={e => e.stopPropagation()}
              >
                <div className="p-8 border-b flex items-center justify-between sticky top-0 bg-card z-10">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-muted rounded-xl">
                      <History className="w-5 h-5 text-primary" />
                    </div>
                    <h2 className="text-xl font-extrabold">Download History</h2>
                  </div>
                  <div className="flex items-center gap-2">
                    {history.length > 0 && (
                      <button onClick={clearHistory} className="p-2.5 text-muted-foreground hover:text-destructive transition-colors">
                        <Trash2 className="w-5 h-5" />
                      </button>
                    )}
                    <button onClick={() => setShowHistory(false)} className="p-2.5 bg-muted rounded-xl hover:bg-muted/80 transition-colors">
                      <X className="w-5 h-5" />
                    </button>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto p-6 space-y-4 no-scrollbar">
                  {history.length === 0 ? (
                    <div className="py-20 text-center">
                      <div className="w-20 h-20 bg-muted rounded-3xl flex items-center justify-center mx-auto mb-6">
                        <History className="w-10 h-10 text-muted-foreground opacity-20" />
                      </div>
                      <h3 className="text-lg font-bold mb-2">No history yet</h3>
                      <p className="text-muted-foreground text-sm">Your downloaded videos will appear here.</p>
                    </div>
                  ) : (
                    history.map((item) => (
                      <div 
                        key={item.id}
                        className="bg-muted/30 p-4 rounded-3xl border border-transparent hover:border-primary/20 transition-all flex gap-5 group cursor-pointer"
                        onClick={() => { setUrl(item.url); setShowHistory(false); handleExtract(); }}
                      >
                        <div className="w-28 h-20 rounded-2xl overflow-hidden flex-shrink-0 bg-muted relative">
                          {item.thumbnail ? (
                            <img src={item.thumbnail} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                          ) : <Play className="w-8 h-8 text-muted-foreground opacity-20 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />}
                          <div className="absolute inset-0 bg-black/10 group-hover:bg-transparent transition-colors" />
                        </div>
                        <div className="flex-1 min-w-0 flex flex-col justify-center">
                          <h4 className="font-bold text-sm truncate group-hover:text-primary transition-colors">{item.title}</h4>
                          <div className="flex items-center gap-3 mt-2">
                            <span className="text-[9px] font-black text-primary bg-primary/10 px-2 py-0.5 rounded-lg uppercase tracking-widest">{item.quality}</span>
                            <span className="text-[9px] font-bold text-muted-foreground uppercase tracking-widest">
                              {new Date(item.timestamp).toLocaleDateString()}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center pr-2">
                          <ExternalLink className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors" />
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Video Player Modal */}
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
      <footer className="py-16 px-4 border-t mt-20">
        <div className="max-w-5xl mx-auto text-center">
          <div className="flex items-center justify-center gap-3 mb-8">
            <div className="orange-gradient p-2 rounded-xl">
              <Download className="w-5 h-5 text-white" />
            </div>
            <span className="text-lg font-black tracking-tight">Video Downloader Pro</span>
          </div>
          <p className="text-muted-foreground text-sm max-w-md mx-auto leading-relaxed mb-10">
            The most powerful and easy-to-use video downloader for all your favorite social media platforms.
          </p>
          <div className="flex justify-center gap-8 text-[10px] font-black text-muted-foreground uppercase tracking-[0.2em]">
            <a href="#" className="hover:text-primary transition-colors">Privacy Policy</a>
            <a href="#" className="hover:text-primary transition-colors">Terms of Service</a>
            <a href="#" className="hover:text-primary transition-colors">Contact Us</a>
          </div>
          <div className="mt-12 pt-12 border-t text-[10px] font-bold text-muted-foreground/40 uppercase tracking-widest">
            © 2026 VDownloader Pro • All Rights Reserved
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
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/95 p-4 md:p-10"
    >
      <div className="relative w-full max-w-6xl bg-black rounded-[2.5rem] overflow-hidden shadow-2xl aspect-video flex items-center justify-center">
        <div className="absolute top-0 left-0 right-0 p-6 bg-gradient-to-b from-black/90 to-transparent z-20 flex items-center justify-between">
          <div className="flex items-center gap-4 min-w-0">
            <div className="w-10 h-10 rounded-full bg-primary flex items-center justify-center flex-shrink-0">
              <Play className="w-5 h-5 text-white fill-current" />
            </div>
            <h3 className="text-white font-bold truncate text-sm md:text-lg">{title}</h3>
          </div>
          <button
            onClick={onClose}
            className="p-3 bg-white/10 hover:bg-white/20 rounded-2xl text-white transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </div>
        
        {loading && !error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 z-10">
            <Loader2 className="w-12 h-12 text-primary animate-spin" />
            <p className="text-white/40 text-[10px] font-black uppercase tracking-[0.3em]">Buffering Preview</p>
          </div>
        )}

        {error ? (
          <div className="flex flex-col items-center justify-center gap-6 p-10 text-center">
            <div className="w-20 h-20 bg-destructive/20 rounded-3xl flex items-center justify-center">
              <AlertCircle className="w-10 h-10 text-destructive" />
            </div>
            <div className="space-y-3">
              <h3 className="text-white text-xl font-bold">Playback Failed</h3>
              <p className="text-white/40 text-sm max-w-sm leading-relaxed">{error}</p>
            </div>
            <button 
              onClick={() => window.open(url, '_blank')}
              className="mt-4 px-8 py-4 bg-white text-black rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-gray-200 transition-all flex items-center gap-3"
            >
              <ExternalLink className="w-4 h-4" />
              Open in Browser
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
              setError("This video format is not supported for direct preview in your browser.");
            }}
            referrerPolicy="no-referrer"
          />
        )}
      </div>
    </motion.div>
  );
}
