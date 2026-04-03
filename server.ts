import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import axios from "axios";
import * as cheerio from "cheerio";

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API route for extracting video links
  app.post("/api/extract", async (req, res) => {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: "URL is required" });
    }

    try {
      // Add hl=en to bypass consent pages and ensure English titles
      const targetUrl = new URL(url);
      if (targetUrl.hostname.includes("youtube.com") || targetUrl.hostname.includes("youtu.be")) {
        if (targetUrl.hostname.includes("youtu.be")) {
          const videoId = targetUrl.pathname.slice(1);
          targetUrl.hostname = "www.youtube.com";
          targetUrl.pathname = "/watch";
          targetUrl.searchParams.set("v", videoId);
        } else if (targetUrl.pathname.startsWith("/shorts/")) {
          const videoId = targetUrl.pathname.split("/")[2];
          targetUrl.pathname = "/watch";
          targetUrl.searchParams.set("v", videoId);
        }
        targetUrl.searchParams.set("hl", "en");
        targetUrl.searchParams.set("bpctr", "9999999999");
        targetUrl.searchParams.set("has_verified", "1");
      }

      const response = await axios.get(targetUrl.href, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Cache-Control": "no-cache",
          "Pragma": "no-cache",
        },
      });

      const html = response.data;
      const $ = cheerio.load(html);
      const title = $('meta[property="og:title"]').attr("content") || $("title").text() || "Video";
      const thumbnail = $('meta[property="og:image"]').attr("content") || $('meta[name="twitter:image"]').attr("content") || "";

      const videoLinks: { quality: string; url: string; format: string; fps?: number; type: "video" | "audio" | "both"; size?: number }[] = [];

      // Generic extraction logic
      // 1. Check for <video> tags
      $("video, video source").each((_, el) => {
        const src = $(el).attr("src") || $(el).attr("data-src");
        const typeAttr = $(el).attr("type") || "";
        const label = $(el).attr("label") || $(el).attr("title") || typeAttr.split("/")[1] || "Download";
        const format = typeAttr.split("/")[1] || src?.split(".").pop()?.split("?")[0] || "mp4";
        const type: "video" | "audio" | "both" = typeAttr.startsWith("audio") ? "audio" : "both";
        if (src && !src.startsWith("blob:")) {
          const absoluteUrl = src.startsWith("http") ? src : new URL(src, url).href;
          videoLinks.push({ quality: label.toUpperCase(), url: absoluteUrl, format: format.toLowerCase(), type });
        }
      });

      // 2. Check for <a> tags with video extensions
      $("a[href]").each((_, el) => {
        const href = $(el).attr("href");
        if (href && href.match(/\.(mp4|mkv|webm|avi|mov|mp3|m4a|wav)(?:\?|$)/i)) {
          const absoluteUrl = href.startsWith("http") ? href : new URL(href, url).href;
          const ext = href.split(".").pop()?.split("?")[0]?.toLowerCase() || "mp4";
          const isAudio = ["mp3", "m4a", "wav"].includes(ext);
          videoLinks.push({ 
            quality: $(el).text().trim() || "Download", 
            url: absoluteUrl, 
            format: ext, 
            type: isAudio ? "audio" : "both" 
          });
        }
      });

      // 3. Site-specific logic
      if (url.includes("xhamster")) {
        const scripts = $("script").toArray();
        for (const script of scripts) {
          const content = $(script).html() || "";
          if (content.includes("initials") || content.includes("sources")) {
            const mp4Regex = /"(144p|240p|360p|480p|720p|1080p|2160p)":"(https:\/\/[^"]+)"/g;
            let match;
            while ((match = mp4Regex.exec(content)) !== null) {
              videoLinks.push({ quality: match[1], url: match[2].replace(/\\/g, ""), format: "mp4", type: "both" });
            }
          }
        }
      } else if (url.includes("youtube.com") || url.includes("youtu.be")) {
        const scripts = $("script").toArray();
        const foundUrls = new Set<string>();
        
        const addLink = (format: any, type: "both" | "video" | "audio") => {
          let linkUrl = format.url;
          if (!linkUrl && format.signatureCipher) {
            const params = new URLSearchParams(format.signatureCipher);
            linkUrl = params.get("url");
            const sig = params.get("s") || params.get("sig");
            const sp = params.get("sp") || "sig";
            if (sig && linkUrl && !linkUrl.includes(`${sp}=`)) {
              linkUrl += `&${sp}=${sig}`;
            }
          }
          
          if (!linkUrl || foundUrls.has(linkUrl)) return;
          foundUrls.add(linkUrl);
          
          let quality = "Unknown";
          if (type === "audio") {
            quality = format.audioSampleRate ? `${format.audioSampleRate}Hz` : (format.bitrate ? `${Math.round(format.bitrate / 1000)}kbps` : "Audio");
          } else {
            const label = format.qualityLabel || (format.height ? `${format.height}p` : format.quality);
            if (label) {
              const match = label.match(/\d+p/);
              quality = match ? match[0] : label;
            } else if (format.height) {
              quality = `${format.height}p`;
            } else if (format.width) {
              // Estimate height from width (16:9)
              quality = `${Math.round(format.width * 9 / 16)}p`;
            }
          }

          const mimeType = format.mimeType || "";
          const formatExt = mimeType.split(";")[0].split("/")[1] || "mp4";
          
          videoLinks.push({ 
            quality, 
            url: linkUrl, 
            format: formatExt, 
            type,
            fps: format.fps,
            size: format.contentLength ? parseInt(format.contentLength) : undefined
          });
        };

        const extractJson = (str: string, startKey: string) => {
          const startIdx = str.indexOf(startKey);
          if (startIdx === -1) return null;
          let braceCount = 0;
          let firstBraceIdx = -1;
          for (let i = startIdx; i < str.length; i++) {
            if (str[i] === '{') {
              if (braceCount === 0) firstBraceIdx = i;
              braceCount++;
            } else if (str[i] === '}') {
              braceCount--;
              if (braceCount === 0 && firstBraceIdx !== -1) {
                try {
                  return JSON.parse(str.substring(firstBraceIdx, i + 1));
                } catch (e) { return null; }
              }
            }
          }
          return null;
        };

        for (const script of scripts) {
          const content = $(script).html() || "";
          
          // Try ytInitialPlayerResponse
          const playerResponse = extractJson(content, "ytInitialPlayerResponse");
          if (playerResponse && playerResponse.streamingData) {
            const sd = playerResponse.streamingData;
            (sd.formats || []).forEach((f: any) => addLink(f, "both"));
            (sd.adaptiveFormats || []).forEach((f: any) => {
              const isAudio = f.mimeType?.startsWith("audio");
              addLink(f, isAudio ? "audio" : "video");
            });
          }

          // Try playerResponse directly
          const prDirect = extractJson(content, "playerResponse");
          if (prDirect && prDirect.streamingData) {
            const sd = prDirect.streamingData;
            (sd.formats || []).forEach((f: any) => addLink(f, "both"));
            (sd.adaptiveFormats || []).forEach((f: any) => {
              const isAudio = f.mimeType?.startsWith("audio");
              addLink(f, isAudio ? "audio" : "video");
            });
          }

          // Try ytplayer.config
          if (content.includes("ytplayer.config")) {
            const config = extractJson(content, "ytplayer.config");
            if (config?.args?.player_response) {
              try {
                const pr = JSON.parse(config.args.player_response);
                if (pr.streamingData) {
                  const sd = pr.streamingData;
                  (sd.formats || []).forEach((f: any) => addLink(f, "both"));
                  (sd.adaptiveFormats || []).forEach((f: any) => {
                    const isAudio = f.mimeType?.startsWith("audio");
                    addLink(f, isAudio ? "audio" : "video");
                  });
                }
              } catch (e) {}
            }
          }

          // Try direct streamingData
          const sd = extractJson(content, "streamingData");
          if (sd) {
            (sd.formats || []).forEach((f: any) => addLink(f, "both"));
            (sd.adaptiveFormats || []).forEach((f: any) => {
              const isAudio = f.mimeType?.startsWith("audio");
              addLink(f, isAudio ? "audio" : "video");
            });
          }
        }
        
        // Final fallback: search in whole HTML if still empty
        if (videoLinks.length === 0) {
           const sd = extractJson(html, "streamingData");
           if (sd) {
             (sd.formats || []).forEach((f: any) => addLink(f, "both"));
             (sd.adaptiveFormats || []).forEach((f: any) => {
               const isAudio = f.mimeType?.startsWith("audio");
               addLink(f, isAudio ? "audio" : "video");
             });
           }
        }
      }
 else if (url.includes("vimeo.com")) {
        const vimeoIdMatch = url.match(/vimeo\.com\/(\d+)/);
        if (vimeoIdMatch) {
          const vimeoId = vimeoIdMatch[1];
          try {
            const configResponse = await axios.get(`https://player.vimeo.com/video/${vimeoId}/config`);
            const config = configResponse.data;
            const files = config.request?.files?.progressive || [];
            files.forEach((file: any) => {
              videoLinks.push({ quality: `${file.quality}p`, url: file.url, format: "mp4", type: "both", fps: file.fps });
            });
          } catch (e) {
            console.error("Vimeo config fetch error");
          }
        }
      } else if (url.includes("dailymotion.com") || url.includes("dai.ly")) {
        const dmIdMatch = url.match(/(?:dailymotion\.com\/video\/|dai\.ly\/)([a-zA-Z0-9]+)/);
        if (dmIdMatch) {
          const dmId = dmIdMatch[1];
          try {
            const apiRes = await axios.get(`https://api.dailymotion.com/video/${dmId}?fields=urls,title,thumbnail_url`);
            const data = apiRes.data;
            if (data.urls) {
               Object.keys(data.urls).forEach(key => {
                 if (key.includes("url")) {
                   videoLinks.push({ quality: key.replace("url_", ""), url: data.urls[key], format: "mp4", type: "both" });
                 }
               });
            }
          } catch (e) {
            console.error("Dailymotion API error");
          }
        }
      } else if (url.includes("instagram.com")) {
        // Instagram extraction (basic meta tag check)
        const videoUrl = $('meta[property="og:video"]').attr("content") || $('meta[property="og:video:url"]').attr("content") || $('meta[property="og:video:secure_url"]').attr("content");
        if (videoUrl) {
          videoLinks.push({ quality: "HD", url: videoUrl, format: "mp4", type: "both" });
        }
      } else if (url.includes("tiktok.com")) {
        // TikTok extraction (very basic, often requires specialized scrapers, but we can try meta tags)
        const videoUrl = $('meta[property="og:video"]').attr("content") || $('meta[property="og:video:secure_url"]').attr("content");
        if (videoUrl) {
          videoLinks.push({ quality: "Original", url: videoUrl, format: "mp4", type: "both" });
        }
      } else if (url.includes("twitter.com") || url.includes("x.com")) {
        // Twitter/X extraction (basic meta tag check)
        const videoUrl = $('meta[property="og:video:url"]').attr("content") || $('meta[name="twitter:player:stream"]').attr("content");
        if (videoUrl) {
          videoLinks.push({ quality: "HD", url: videoUrl, format: "mp4", type: "both" });
        }
      } else if (url.includes("facebook.com") || url.includes("fb.watch")) {
        const videoUrl = $('meta[property="og:video"]').attr("content") || $('meta[property="og:video:url"]').attr("content") || $('meta[property="og:video:secure_url"]').attr("content");
        if (videoUrl) {
          videoLinks.push({ quality: "HD", url: videoUrl, format: "mp4", type: "both" });
        }
      }

      // 4. Final fallback: Check all meta tags for video URLs
      if (videoLinks.length === 0) {
        $('meta[property^="og:video"], meta[name^="twitter:player"]').each((_, el) => {
          const content = $(el).attr("content");
          if (content && content.startsWith("http") && content.match(/\.(mp4|m4v|webm|ogv|mov)(?:\?|$)/i)) {
            videoLinks.push({ quality: "Direct", url: content, format: "mp4", type: "both" });
          }
        });
      }

      // De-duplicate links by quality, url, format, type and fps
      const uniqueLinks = Array.from(new Map(videoLinks.map(item => [item.quality + item.url + item.format + item.type + (item.fps || ""), item])).values());

      res.json({
        title,
        thumbnail,
        links: uniqueLinks,
      });
    } catch (error: any) {
      console.error("Extraction error:", error.message);
      res.status(500).json({ error: "Failed to extract video links. The site might be protected or the URL is invalid." });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
