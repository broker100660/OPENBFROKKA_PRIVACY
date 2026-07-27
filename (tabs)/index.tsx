import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Modal,
  TextInput,
  Alert,
  useWindowDimensions,
  FlatList,
  ActivityIndicator,
  Share,
  Linking,
  StatusBar,
  PermissionsAndroid,
  KeyboardAvoidingView,
  RefreshControl,
  Platform,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { WebView } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { Picker } from '@react-native-picker/picker';
import { API_URL } from '../../config/api';
import RNFS from 'react-native-fs';
import DateTimePicker from '@react-native-community/datetimepicker';
import messaging from '@react-native-firebase/messaging';

const FEED_LIMIT = 10;
const GUEST_KEY  = 'guest_id';

async function getOrCreateGuestId(): Promise<string> {
  let id = await AsyncStorage.getItem(GUEST_KEY);
  if (!id) {
    id = 'guest_' + Math.random().toString(36).substr(2, 9);
    await AsyncStorage.setItem(GUEST_KEY, id);
  }
  return id;
}

async function initGuest(guestId: string) {
  try {
    await fetch(`${API_URL}/api/guests/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guest_id: guestId, user_agent: 'ReactNative' }),
    });
  } catch (_) {}
}

// Shared shape for RENT, PROPERTIES-for-sale, and LAND feed items.
// area_type / dimension_unit / size_width / size_length / property_usage
// exist on both properties-for-sale and land records. bedroom_type only
// exists on RENT/PROPERTIES; land has no bedroom_type at all.
interface Property {
  id: number;
  video_url: string;
  property_type: string;
  bedroom_type?: string;
  village: string;
  price: string | number;
  broker_fee: string | number;
  transport_to_town: string;
  to_main_road: string;
  area_type?: string;
  dimension_unit?: string;
  size_width?: string | number;
  size_length?: string | number;
  property_usage?: string;
}

interface Filters {
  price: 'budget' | 'mid' | 'standard' | 'premium';
  region: string;
  district: string;
  subcounty: string;
}

function getStreamId(url: string): string | null {
  if (!url) return null;
  const parts = url.split('/');
  return parts[3] || null;
}

// Human-readable property_usage label — values differ between
// PROPERTIES (has_rental_units/residential_only) and LAND
// (rentals_apartments/residence/shops).
function formatUsage(usage: string | undefined, land?: boolean): string {
  if (!usage) return '';
  if (land) {
    if (usage === 'rentals_apartments') return 'For rentals/apartments';
    if (usage === 'residence') return 'Residence';
    if (usage === 'shops') return 'Shops';
    return usage;
  }
  return usage === 'has_rental_units' ? 'Has rental units' : 'Residential only';
}

const UNMUTE_AND_STYLE_JS = `
  (function() {
    var style = document.createElement('style');
    style.innerHTML = \`
      * { margin: 0 !important; padding: 0 !important; box-sizing: border-box !important; }
      html, body {
        width: 100% !important;
        height: 100% !important;
        overflow: hidden !important;
        background: #000 !important;
      }
      iframe, video {
        position: fixed !important;
        top: 0 !important; left: 0 !important;
        width: 100vw !important;
        height: 100vh !important;
        object-fit: cover !important;
      }
      video::-webkit-media-controls { display: none !important; }
    \`;
    document.head.appendChild(style);
    function tryUnmute() {
      var vid = document.querySelector('video');
      if (vid) {
        vid.muted = false;
        vid.volume = 1.0;
        vid.controls = false;
        vid.play();
      } else {
        setTimeout(tryUnmute, 300);
      }
    }
    tryUnmute();
  })();
  true;
`;

// ─── Single Video Slide ───────────────────────────────────────────────────────
// forSale=true renders the extra properties-for-sale fields (area type,
// dimensions, property usage) below the standard property info.
// land=true renders the same extra fields but with land's property_usage
// wording and no bedroom_type in the title line (property_usage instead).
// bottomInset = the real height of the bottom tab bar (HOME/BOOKINGS),
// passed in from the parent via useBottomTabBarHeight(). Without this,
// the property info text and the CARE/SHARE/BOOK action buttons were
// positioned with fixed pixel offsets that didn't account for the tab
// bar, so on some screens the bottom lines (transport cost, road
// distance, broker fee) got clipped underneath it.
const VideoSlide = React.memo(({
  item, isActive, isAdjacent, screenWidth, screenHeight, forSale, land, bottomInset,
}: {
  item: Property;
  isActive: boolean;
  isAdjacent: boolean;
  screenWidth: number;
  screenHeight: number;
  forSale?: boolean;
  land?: boolean;
  bottomInset?: number;
}) => {
  const streamId = getStreamId(item.video_url);
  const [paused, setPaused]     = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const webviewRef = useRef<WebView>(null);

  useEffect(() => {
    if (isActive) {
      setTimeout(() => {
        webviewRef.current?.injectJavaScript(UNMUTE_AND_STYLE_JS);
      }, 300);
    } else {
      webviewRef.current?.injectJavaScript(`
        var v = document.querySelector('video');
        if (v) { v.muted = true; v.pause(); }
        true;
      `);
      setPaused(false);
    }
  }, [isActive]);

  useEffect(() => {
    if (!isActive) return;
    const interval = setInterval(() => {
      webviewRef.current?.injectJavaScript(`
        var v = document.querySelector('video');
        if (v && v.duration > 0) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'progress',
            currentTime: v.currentTime,
            duration: v.duration
          }));
        }
        true;
      `);
    }, 1000);
    return () => clearInterval(interval);
  }, [isActive]);

  const handleMessage = (event: any) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'progress' && msg.duration > 0) {
        setProgress(msg.currentTime / msg.duration);
        setDuration(msg.duration);
      }
    } catch (_) {}
  };

  const handleScrub = (e: any) => {
    const x = e.nativeEvent.locationX;
    const ratio = Math.max(0, Math.min(1, x / screenWidth));
    const seekTo = ratio * duration;
    webviewRef.current?.injectJavaScript(`
      var v = document.querySelector('video');
      if (v) { v.currentTime = ${seekTo}; }
      true;
    `);
    setProgress(ratio);
  };

  const togglePause = () => {
    if (!isActive) return;
    const next = !paused;
    setPaused(next);
    webviewRef.current?.injectJavaScript(
      next
        ? `var v=document.querySelector('video');if(v)v.pause();true;`
        : `var v=document.querySelector('video');if(v){v.muted=false;v.volume=1.0;v.play();}true;`
    );
  };

  const uri = streamId
    ? `https://iframe.videodelivery.net/${streamId}?autoplay=1&loop=1&muted=1&preload=auto`
    : null;

  // Title line: land has no bedroom_type, so show property_usage there
  // instead. RENT/PROPERTIES keep property_type · bedroom_type.
  const titleLine = land
    ? `${item.property_type}${item.property_usage ? ' · ' + formatUsage(item.property_usage, true) : ''}`
    : `${item.property_type} · ${item.bedroom_type || ''}`;

  const safeBottomInset = bottomInset || 0;

  return (
    <View style={{ width: screenWidth, height: screenHeight, backgroundColor: '#000' }}>
      {uri && (isActive || isAdjacent) ? (
        <WebView
          ref={webviewRef}
          source={{ uri }}
          style={[StyleSheet.absoluteFill, { opacity: isActive ? 1 : 0 }]}
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          javaScriptEnabled
          scrollEnabled={false}
          allowsFullscreenVideo={false}
          onMessage={handleMessage}
          onLoad={() => {
            webviewRef.current?.injectJavaScript(`
              var v = document.querySelector('video');
              if (v) { v.muted = true; v.pause(); }
              true;
            `);
          }}
        />
      ) : (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }]} />
      )}

      <TouchableOpacity
        activeOpacity={1}
        onPress={togglePause}
        style={[StyleSheet.absoluteFill, { zIndex: 10 }]}
      >
        {paused && isActive && (
          <View style={styles.pausePill} pointerEvents="none">
            <Text style={styles.pausePillText}>▐▐  Paused</Text>
          </View>
        )}
        <View style={[styles.propInfo, { bottom: 47 + safeBottomInset }]} pointerEvents="none">
          <Text style={styles.propType}>{titleLine}</Text>
          <Text style={styles.propMeta}>📍 {item.village}</Text>
          <Text style={styles.propPrice}>UGX {item.price}</Text>
          <Text style={styles.propMeta}>🚌 {item.transport_to_town}</Text>
          <Text style={styles.propMeta}>🛣 {item.to_main_road}</Text>
          <Text style={styles.propMeta}>Broker Fee: UGX {item.broker_fee}</Text>

          {(forSale || land) && (
            <>
              {item.area_type && (
                <Text style={styles.propMeta}>🗺 Area: {item.area_type}</Text>
              )}
              {item.size_width && item.size_length && (
                <Text style={styles.propMeta}>
                  📐 {item.size_width} × {item.size_length} {item.dimension_unit || ''}
                </Text>
              )}
              {/* For PROPERTIES this repeats the usage already shown in the
                  title line above for LAND — that's intentional, since
                  PROPERTIES still shows bedroom_type in the title, not usage. */}
              {!land && item.property_usage && (
                <Text style={styles.propMeta}>
                  🏷 {formatUsage(item.property_usage, false)}
                </Text>
              )}
            </>
          )}
        </View>
      </TouchableOpacity>

      {isActive && duration > 0 && (
        <TouchableOpacity
          activeOpacity={1}
          onPress={handleScrub}
          style={{
            position: 'absolute',
            bottom: 27 + safeBottomInset,
            left: 0,
            right: 0,
            height: 28,
            justifyContent: 'center',
            zIndex: 999,
          }}
        >
          <View style={{ height: 3, backgroundColor: 'rgba(255,255,255,0.3)', width: '100%' }}>
            <View style={{ height: 3, backgroundColor: '#D4AF37', width: `${progress * 100}%` }} />
          </View>
          <View style={{
            position: 'absolute',
            left: `${progress * 100}%`,
            width: 14,
            height: 14,
            borderRadius: 7,
            backgroundColor: '#D4AF37',
            top: 7,
            marginLeft: -7,
          }} />
        </TouchableOpacity>
      )}
    </View>
  );
});

const ShareIcon = () => <Text style={{ fontSize: 22 }}>🔗</Text>;
const BookIcon  = () => <Text style={{ fontSize: 22 }}>🏠</Text>;
const CareIcon  = () => <Text style={{ fontSize: 22 }}>💬</Text>;

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function Home() {
  const insets = useSafeAreaInsets();
  const tabBarHeight = useBottomTabBarHeight();
  const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = useWindowDimensions();

  const registerFCMToken = async (guestId: string) => {
    try {
      if (Platform.OS === 'android' && Platform.Version >= 33) {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
        );
        if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
          console.log('[FCM] Permission denied');
          return;
        }
      }

      const authStatus = await messaging().requestPermission();
      const enabled =
        authStatus === messaging.AuthorizationStatus.AUTHORIZED ||
        authStatus === messaging.AuthorizationStatus.PROVISIONAL;

      if (!enabled) {
        console.log('[FCM] Not enabled:', authStatus);
        return;
      }

      const fcmToken = await messaging().getToken();
      if (!fcmToken) {
        console.log('[FCM] No token received');
        return;
      }

      console.log('[FCM] Token:', fcmToken);

      await fetch(`${API_URL}/api/notifications/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: guestId,
          user_type: 'guest',
          fcm_token: fcmToken,
        }),
      });

      console.log('[FCM] Token registered successfully');
    } catch (err: any) {
      console.log('[FCM] Token registration error:', err.message);
    }
  };

  const [activeTab, setActiveTab] = useState<'RENT' | 'LAND' | 'PROPERTIES'>('RENT');
  const [sortOpen, setSortOpen]   = useState(false);
  const [filters, setFilters] = useState<Filters>({ price: 'mid', region: '', district: '', subcounty: '' });
  const filtersRef = useRef(filters);
  useEffect(() => { filtersRef.current = filters; }, [filters]);

  // ── Search (village or exact price) — last item in the Sort panel.
  // Non-destructive: if no match is found in the currently loaded feed,
  // nothing changes and the person stays on whatever video they're
  // watching. If a match IS found, we scroll to it in place.
  const [searchQuery, setSearchQuery] = useState('');

  const [regions, setRegions]         = useState<any[]>([]);
  const [districts, setDistricts]     = useState<any[]>([]);
  const [subcounties, setSubcounties] = useState<any[]>([]);

  // ── RENT feed state (unchanged) ──
  const [properties, setProperties]   = useState<Property[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing]   = useState(false);

  // ── PROPERTIES (for-sale) feed state — mirrors RENT ──
  const [propertiesForSale, setPropertiesForSale]     = useState<Property[]>([]);
  const [activeIndexForSale, setActiveIndexForSale]   = useState(0);
  const [initialLoadingForSale, setInitialLoadingForSale] = useState(true);
  const [refreshingForSale, setRefreshingForSale]     = useState(false);

  // ── LAND feed state — mirrors PROPERTIES ──
  const [landProperties, setLandProperties]           = useState<Property[]>([]);
  const [activeIndexLand, setActiveIndexLand]         = useState(0);
  const [initialLoadingLand, setInitialLoadingLand]   = useState(true);
  const [refreshingLand, setRefreshingLand]           = useState(false);

  const [bookVisible, setBookVisible]   = useState(false);
  const [careVisible, setCareVisible]   = useState(false);
  const [shareVisible, setShareVisible] = useState(false);
  const [guestName, setGuestName]       = useState('');
  const [phone, setPhone]               = useState('');
  const [bookingStep, setBookingStep]   = useState<'idle' | 'pending' | 'verify'>('idle');
  const [yoRef, setYoRef]               = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
const [bookingMode, setBookingMode] =
  useState<'pay_now' | 'pay_after'>('pay_now');

const [visitDate, setVisitDate] =
  useState(new Date());

const [showDatePicker, setShowDatePicker] =
  useState(false);

const [visitTimeSlot, setVisitTimeSlot] =
  useState<'morning' | 'afternoon' | 'evening'>(
    'morning'
  );
  const [queryText, setQueryText]       = useState('');
  const [queryPhone, setQueryPhone]     = useState('');
  const [downloading, setDownloading]   = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);

  const flatListRef   = useRef<FlatList>(null);
  const offsetRef     = useRef(0);
  const loadingRef    = useRef(false);
  const propertiesRef = useRef<Property[]>([]);
  const guestIdRef    = useRef<string | null>(null);

  // ── PROPERTIES (for-sale) refs — mirrors RENT ──
  const flatListForSaleRef   = useRef<FlatList>(null);
  const offsetForSaleRef     = useRef(0);
  const loadingForSaleRef    = useRef(false);
  const propertiesForSaleRef = useRef<Property[]>([]);

  // ── LAND refs — mirrors PROPERTIES ──
  const flatListLandRef   = useRef<FlatList>(null);
  const offsetLandRef     = useRef(0);
  const loadingLandRef    = useRef(false);
  const propertiesLandRef = useRef<Property[]>([]);

  useEffect(() => {
    (async () => {
      const id = await getOrCreateGuestId();
      guestIdRef.current = id;
      await initGuest(id);
      await registerFCMToken(id);
      await fetchRegions();
      await loadFeed(0, []);
      await loadFeedForSale(0, []);
      await loadFeedLand(0, []);
    })();
  }, []);

  const fetchRegions = async () => {
    try {
      const res = await fetch(`${API_URL}/api/regions`);
      setRegions(await res.json());
    } catch (_) {}
  };

  const fetchDistricts = async (regionName: string) => {
    try {
      const region = regions.find((r: any) => r.name === regionName);
      if (!region) { setDistricts([]); setSubcounties([]); return; }
      const res = await fetch(`${API_URL}/api/districts/${region.id}`);
      setDistricts(await res.json());
      setSubcounties([]);
    } catch (_) {}
  };

  const fetchSubcounties = async (districtName: string) => {
    try {
      const district = districts.find((d: any) => d.name === districtName);
      if (!district) { setSubcounties([]); return; }
      const res = await fetch(`${API_URL}/api/subcounties/${district.id}`);
      setSubcounties(await res.json());
    } catch (_) {}
  };

  // ── RENT feed loader (unchanged) ──
  const loadFeed = useCallback(async (offset: number, existing: Property[]) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const f = filtersRef.current;
      const params = new URLSearchParams({ limit: String(FEED_LIMIT), offset: String(offset) });
      if (f.price)     params.append('price',     f.price);
      if (f.region)    params.append('region',    f.region);
      if (f.district)  params.append('district',  f.district);
      if (f.subcounty) params.append('subcounty', f.subcounty);
      const res  = await fetch(`${API_URL}/api/properties/feed?${params}`);
      const data = await res.json();
      if (data?.items?.length) {
        const updated = [...existing, ...data.items];
        setProperties(updated);
        propertiesRef.current = updated;
        offsetRef.current = offset + data.items.length;
      }
    } catch (e) { console.log('Feed error:', e); }
    finally { loadingRef.current = false; setInitialLoading(false); setRefreshing(false); }
  }, []);

  // ── PROPERTIES (for-sale) feed loader — same shape as RENT ──
  const loadFeedForSale = useCallback(async (offset: number, existing: Property[]) => {
    if (loadingForSaleRef.current) return;
    loadingForSaleRef.current = true;
    try {
      const f = filtersRef.current;
      const params = new URLSearchParams({ limit: String(FEED_LIMIT), offset: String(offset) });
      if (f.price)     params.append('price',     f.price);
      if (f.region)    params.append('region',    f.region);
      if (f.district)  params.append('district',  f.district);
      if (f.subcounty) params.append('subcounty', f.subcounty);
      const res  = await fetch(`${API_URL}/api/properties-for-sale/feed?${params}`);
      const data = await res.json();
      if (data?.items?.length) {
        const updated = [...existing, ...data.items];
        setPropertiesForSale(updated);
        propertiesForSaleRef.current = updated;
        offsetForSaleRef.current = offset + data.items.length;
      }
    } catch (e) { console.log('Properties-for-sale feed error:', e); }
    finally { loadingForSaleRef.current = false; setInitialLoadingForSale(false); setRefreshingForSale(false); }
  }, []);

  // ── LAND feed loader — mirrors loadFeedForSale, hits /api/land-properties/feed ──
  const loadFeedLand = useCallback(async (offset: number, existing: Property[]) => {
    if (loadingLandRef.current) return;
    loadingLandRef.current = true;
    try {
      const f = filtersRef.current;
      const params = new URLSearchParams({ limit: String(FEED_LIMIT), offset: String(offset) });
      if (f.price)     params.append('price',     f.price);
      if (f.region)    params.append('region',    f.region);
      if (f.district)  params.append('district',  f.district);
      if (f.subcounty) params.append('subcounty', f.subcounty);
      const res  = await fetch(`${API_URL}/api/land-properties/feed?${params}`);
      const data = await res.json();
      if (data?.items?.length) {
        const updated = [...existing, ...data.items];
        setLandProperties(updated);
        propertiesLandRef.current = updated;
        offsetLandRef.current = offset + data.items.length;
      }
    } catch (e) { console.log('Land feed error:', e); }
    finally { loadingLandRef.current = false; setInitialLoadingLand(false); setRefreshingLand(false); }
  }, []);

  const resetAndLoad = useCallback(() => {
    setProperties([]); propertiesRef.current = [];
    offsetRef.current = 0; setActiveIndex(0);
    flatListRef.current?.scrollToOffset({ offset: 0, animated: false });
    setInitialLoading(true);
    loadFeed(0, []);
  }, [loadFeed]);

  const resetAndLoadForSale = useCallback(() => {
    setPropertiesForSale([]); propertiesForSaleRef.current = [];
    offsetForSaleRef.current = 0; setActiveIndexForSale(0);
    flatListForSaleRef.current?.scrollToOffset({ offset: 0, animated: false });
    setInitialLoadingForSale(true);
    loadFeedForSale(0, []);
  }, [loadFeedForSale]);

  const resetAndLoadLand = useCallback(() => {
    setLandProperties([]); propertiesLandRef.current = [];
    offsetLandRef.current = 0; setActiveIndexLand(0);
    flatListLandRef.current?.scrollToOffset({ offset: 0, animated: false });
    setInitialLoadingLand(true);
    loadFeedLand(0, []);
  }, [loadFeedLand]);

  // Re-applies the current filters to whichever tab is active
  const resetAndLoadActiveTab = useCallback(() => {
    if (activeTab === 'PROPERTIES') resetAndLoadForSale();
    else if (activeTab === 'LAND') resetAndLoadLand();
    else resetAndLoad();
  }, [activeTab, resetAndLoad, resetAndLoadForSale, resetAndLoadLand]);

  const onRefresh = useCallback(() => {
    setProperties([]); propertiesRef.current = [];
    offsetRef.current = 0; setActiveIndex(0);
    flatListRef.current?.scrollToOffset({ offset: 0, animated: false });
    setRefreshing(true);
    loadFeed(0, []);
  }, [loadFeed]);

  const onRefreshForSale = useCallback(() => {
    setPropertiesForSale([]); propertiesForSaleRef.current = [];
    offsetForSaleRef.current = 0; setActiveIndexForSale(0);
    flatListForSaleRef.current?.scrollToOffset({ offset: 0, animated: false });
    setRefreshingForSale(true);
    loadFeedForSale(0, []);
  }, [loadFeedForSale]);

  const onRefreshLand = useCallback(() => {
    setLandProperties([]); propertiesLandRef.current = [];
    offsetLandRef.current = 0; setActiveIndexLand(0);
    flatListLandRef.current?.scrollToOffset({ offset: 0, animated: false });
    setRefreshingLand(true);
    loadFeedLand(0, []);
  }, [loadFeedLand]);

  const onViewableItemsChanged = useCallback(({ viewableItems }: any) => {
    if (viewableItems.length > 0) {
      const idx = viewableItems[0].index ?? 0;
      setActiveIndex(idx);
      if (idx >= propertiesRef.current.length - 2) {
        loadFeed(offsetRef.current, propertiesRef.current);
      }
    }
  }, [loadFeed]);

  const onViewableItemsChangedForSale = useCallback(({ viewableItems }: any) => {
    if (viewableItems.length > 0) {
      const idx = viewableItems[0].index ?? 0;
      setActiveIndexForSale(idx);
      if (idx >= propertiesForSaleRef.current.length - 2) {
        loadFeedForSale(offsetForSaleRef.current, propertiesForSaleRef.current);
      }
    }
  }, [loadFeedForSale]);

  const onViewableItemsChangedLand = useCallback(({ viewableItems }: any) => {
    if (viewableItems.length > 0) {
      const idx = viewableItems[0].index ?? 0;
      setActiveIndexLand(idx);
      if (idx >= propertiesLandRef.current.length - 2) {
        loadFeedLand(offsetLandRef.current, propertiesLandRef.current);
      }
    }
  }, [loadFeedLand]);

  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 80 });

  // The property currently on screen, for whichever tab is active —
  // used by Book / Share / Care modals below.
  const currentProp =
    activeTab === 'PROPERTIES' ? propertiesForSale[activeIndexForSale] :
    activeTab === 'LAND' ? landProperties[activeIndexLand] :
    properties[activeIndex];

  // ── SEARCH (village or exact price) ──────────────────────────────────
  // Searches only within the currently loaded (already-fetched) list for
  // the active tab. If a match exists, scroll to it in place — this
  // never clears/replaces the feed, so infinite-scroll pagination and
  // everything else keeps working exactly as before. If NO match is
  // found, nothing happens at all: the person stays exactly where they
  // were, on the same video.
  const handleSearch = useCallback(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return;

    const currentData =
      activeTab === 'PROPERTIES' ? propertiesForSaleRef.current :
      activeTab === 'LAND' ? propertiesLandRef.current :
      propertiesRef.current;

    const currentListRef =
      activeTab === 'PROPERTIES' ? flatListForSaleRef :
      activeTab === 'LAND' ? flatListLandRef :
      flatListRef;

    const setActiveIdx =
      activeTab === 'PROPERTIES' ? setActiveIndexForSale :
      activeTab === 'LAND' ? setActiveIndexLand :
      setActiveIndex;

    // Numeric query → try an exact price match first (strip commas).
    const numericQuery = Number(query.replace(/,/g, ''));
    const isNumeric = !isNaN(numericQuery) && numericQuery > 0;

    const matchIndex = currentData.findIndex((item) => {
      const villageMatch = item.village?.toLowerCase().includes(query);
      const priceMatch = isNumeric
        ? Number(String(item.price).replace(/,/g, '')) === numericQuery
        : false;
      return villageMatch || priceMatch;
    });

    if (matchIndex === -1) {
      // No match anywhere in what's currently loaded — stay put, just
      // let the person know instead of disturbing their video.
      Alert.alert('No matches', 'No loaded property matches that search. Staying on your current view.');
      return;
    }

    currentListRef.current?.scrollToIndex({ index: matchIndex, animated: true });
    setActiveIdx(matchIndex);
    setSortOpen(false);
    setSearchQuery('');
  }, [searchQuery, activeTab]);

  const handleProceed = async () => {
    if (!guestName.trim()) { Alert.alert('Enter your full name'); return; }
    if (!phone.trim())     { Alert.alert('Enter your phone number'); return; }
    let digits = phone.replace(/\D/g, '');
    if (digits.startsWith('0')) digits = '256' + digits.slice(1);
    if (!digits.startsWith('256') || digits.length !== 12) {
      Alert.alert('Invalid phone', 'Use format 07XXXXXXXX'); return;
    }
    setBookingStep('pending');
    try {
      const res = await fetch(`${API_URL}/api/payments/airtel/initiate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          property_id: activeTab === 'PROPERTIES' ? currentProp?.id : Number(currentProp?.id),
          property_category: activeTab === 'PROPERTIES' ? 'sale' : activeTab === 'LAND' ? 'land' : 'rent',
          phone: '+' + digits,
          name: guestName.trim(),
          user_id: guestIdRef.current,
          user_type: 'guest',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setYoRef(data.external_ref || null); // reused state var, now holds Airtel's external_ref
      setBookingStep('verify');
      Alert.alert('Payment sent', 'Complete payment on your phone then tap Verify.');
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed');
      setBookingStep('idle');
    }
  };

  const handleVerify = async () => {
  if (!yoRef) { Alert.alert('Tap Proceed first.'); return; }
  if (verifying) return;
  setVerifying(true);
  try {
    const res = await fetch(`${API_URL}/api/payments/airtel/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction_id: yoRef }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    await AsyncStorage.setItem('booking_id', String(data.booking_id));
    setBookVisible(false); setBookingStep('idle');
    setPhone(''); setGuestName(''); setYoRef(null);
    Alert.alert('✅ Booking confirmed!');
  } catch (err: any) {
    Alert.alert('Error', err.message || 'Failed');
  } finally {
    setVerifying(false);
  }
};
const handleScheduleVisit = async () => {
  if (!guestName.trim()) {
    Alert.alert('Enter your full name');
    return;
  }

  if (!phone.trim()) {
    Alert.alert('Enter phone number');
    return;
  }

  let digits = phone.replace(/\D/g, '');

  if (digits.startsWith('0')) {
    digits = '256' + digits.slice(1);
  }

  if (
    !digits.startsWith('256') ||
    digits.length !== 12
  ) {
    Alert.alert(
      'Invalid phone',
      'Use format 07XXXXXXXX'
    );
    return;
  }

  try {
    const res = await fetch(
      `${API_URL}/api/visits/request`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          property_id: currentProp?.id,
          // Tells the backend which table this id belongs to — required
          // now that RENT and LAND both use plain integer ids that could
          // otherwise collide.
          property_category:
            activeTab === 'PROPERTIES' ? 'sale' :
            activeTab === 'LAND' ? 'land' :
            'rent',
          guest_id: guestIdRef.current,
          guest_name: guestName.trim(),
          phone: digits,
          preferred_date:
            visitDate.toISOString().split('T')[0],
          preferred_time_slot: visitTimeSlot,
        }),
      }
    );

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error);
    }

    Alert.alert(
      'Visit Scheduled',
      'Customer care will contact you shortly.'
    );

    setBookVisible(false);
    setGuestName('');
    setPhone('');
    setBookingMode('pay_now');
  } catch (err: any) {
    Alert.alert(
      'Error',
      err.message || 'Failed to schedule visit'
    );
  }
};
  const closeBookModal = () => {
    setBookVisible(false); setBookingStep('idle');
    setPhone(''); setGuestName('');
  };

  const handleShare = async () => {
    if (!currentProp) return;
    const streamId = getStreamId(currentProp.video_url);
    const shareUrl = streamId
      ? `https://iframe.videodelivery.net/${streamId}`
      : currentProp.video_url;
    const subtitle = activeTab === 'LAND'
      ? formatUsage(currentProp.property_usage, true)
      : currentProp.bedroom_type;
    try {
      await Share.share({
        message: `🏠 ${currentProp.property_type} · ${subtitle} in ${currentProp.village}\n💰 UGX ${currentProp.price}\n\nView property: ${shareUrl}`,
        url: shareUrl,
      });
    } catch (_) {}
    setShareVisible(false);
  };

  const handleDownloadVideo = async () => {
  if (!currentProp) return;
  const streamId = getStreamId(currentProp.video_url);
  if (!streamId) { Alert.alert('Error', 'Could not get video ID'); return; }

  setShareVisible(false);
  setDownloading(true);
  setDownloadProgress(0);

  try {
    await fetch(`${API_URL}/api/videos/download/${streamId}`);
    
    const cloudflareUrl = `https://customer-8h9ilxjspdsoexf3.cloudflarestream.com/${streamId}/downloads/default.mp4`;
    const localPath = `${RNFS.CachesDirectoryPath}/openbrokka_${streamId}.mp4`;

    const result = await RNFS.downloadFile({
      fromUrl: cloudflareUrl,
      toFile: localPath,
      connectionTimeout: 60000,
      readTimeout: 120000,
      progressDivider: 10,
      begin: () => console.log('[DOWNLOAD] Started'),
      progress: (res) => {
        const p = (res.bytesWritten / res.contentLength) * 100;
        setDownloadProgress(Math.round(p));
      },
    }).promise;

    if (result.statusCode !== 200) throw new Error('Failed');

    // Fix: use localPath not destPath
    await RNFS.moveFile(localPath, `${RNFS.ExternalStorageDirectoryPath}/DCIM/openbrokka_${streamId}.mp4`);
    await RNFS.scanFile(`${RNFS.ExternalStorageDirectoryPath}/DCIM/openbrokka_${streamId}.mp4`);

    Alert.alert('✅ Saved!', 'Video saved to your gallery');
  } catch (err: any) {
    Alert.alert('Error', 'Could not download video. Please try again.');
  } finally {
    setDownloading(false);
    setDownloadProgress(0);
  }
};
  const saveLog = async (network: string | null, action: string, query?: string, qPhone?: string) => {
    try {
      await fetch(`${API_URL}/customer-care/logs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: guestIdRef.current, userType: 'guest',
          network, action, query: query || null, phone: qPhone || null,
        }),
      });
    } catch (_) {}
  };

  const handleCall = async (network: string) => {
    const number = network === 'AIRTEL' ? '+256705679012' : '+256784160679';
    await saveLog(network, 'call');
    Linking.openURL(`tel:${number}`);
    setCareVisible(false);
  };

  const handleEmail = async () => {
    await saveLog('email', 'email');
    Linking.openURL('mailto:openbrokka@gmail.com');
    setCareVisible(false);
  };

  const submitQuery = async () => {
    await saveLog(null, 'query', queryText, queryPhone);
    setQueryText(''); setQueryPhone('');
    setCareVisible(false);
    Alert.alert('Query submitted!');
  };

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" translucent backgroundColor="transparent" />

      {activeTab === 'RENT' && (
        <>
          {initialLoading ? (
            <View style={styles.loader}>
              <ActivityIndicator size="large" color="#D4AF37" />
              <Text style={styles.loaderText}>Loading…</Text>
            </View>
          ) : (
            <View style={{
              position: 'absolute', top: 0, left: 0,
              width: SCREEN_WIDTH, height: SCREEN_HEIGHT,
            }}>
              <FlatList
                ref={flatListRef}
                data={properties}
                keyExtractor={(item) => String(item.id)}
                renderItem={({ item, index }) => (
                  <VideoSlide
                    item={item}
                    isActive={index === activeIndex}
                    isAdjacent={Math.abs(index - activeIndex) === 1}
                    screenWidth={SCREEN_WIDTH}
                    screenHeight={SCREEN_HEIGHT}
                    bottomInset={tabBarHeight}
                  />
                )}
                pagingEnabled
                showsVerticalScrollIndicator={false}
                snapToInterval={SCREEN_HEIGHT}
                snapToAlignment="start"
                decelerationRate="fast"
                onViewableItemsChanged={onViewableItemsChanged}
                viewabilityConfig={viewabilityConfig.current}
                windowSize={3}
                initialNumToRender={2}
                maxToRenderPerBatch={2}
                getItemLayout={(_, index) => ({
                  length: SCREEN_HEIGHT, offset: SCREEN_HEIGHT * index, index,
                })}
                refreshControl={
                  <RefreshControl
                    refreshing={refreshing}
                    onRefresh={onRefresh}
                    tintColor="#D4AF37"
                    colors={['#D4AF37']}
                  />
                }
              />
            </View>
          )}
        </>
      )}

      {activeTab === 'PROPERTIES' && (
        <>
          {initialLoadingForSale ? (
            <View style={styles.loader}>
              <ActivityIndicator size="large" color="#D4AF37" />
              <Text style={styles.loaderText}>Loading…</Text>
            </View>
          ) : propertiesForSale.length === 0 ? (
            <View style={styles.comingSoon}>
              <Text style={styles.comingSoonEmoji}>🏡</Text>
              <Text style={styles.comingSoonTitle}>No properties yet</Text>
              <Text style={styles.comingSoonSub}>Check back soon for new listings</Text>
            </View>
          ) : (
            <View style={{
              position: 'absolute', top: 0, left: 0,
              width: SCREEN_WIDTH, height: SCREEN_HEIGHT,
            }}>
              <FlatList
                ref={flatListForSaleRef}
                data={propertiesForSale}
                keyExtractor={(item) => String(item.id)}
                renderItem={({ item, index }) => (
                  <VideoSlide
                    item={item}
                    isActive={index === activeIndexForSale}
                    isAdjacent={Math.abs(index - activeIndexForSale) === 1}
                    screenWidth={SCREEN_WIDTH}
                    screenHeight={SCREEN_HEIGHT}
                    forSale
                    bottomInset={tabBarHeight}
                  />
                )}
                pagingEnabled
                showsVerticalScrollIndicator={false}
                snapToInterval={SCREEN_HEIGHT}
                snapToAlignment="start"
                decelerationRate="fast"
                onViewableItemsChanged={onViewableItemsChangedForSale}
                viewabilityConfig={viewabilityConfig.current}
                windowSize={3}
                initialNumToRender={2}
                maxToRenderPerBatch={2}
                getItemLayout={(_, index) => ({
                  length: SCREEN_HEIGHT, offset: SCREEN_HEIGHT * index, index,
                })}
                refreshControl={
                  <RefreshControl
                    refreshing={refreshingForSale}
                    onRefresh={onRefreshForSale}
                    tintColor="#D4AF37"
                    colors={['#D4AF37']}
                  />
                }
              />
            </View>
          )}
        </>
      )}

      {activeTab === 'LAND' && (
        <>
          {initialLoadingLand ? (
            <View style={styles.loader}>
              <ActivityIndicator size="large" color="#D4AF37" />
              <Text style={styles.loaderText}>Loading…</Text>
            </View>
          ) : landProperties.length === 0 ? (
            <View style={styles.comingSoon}>
              <Text style={styles.comingSoonEmoji}>🏞️</Text>
              <Text style={styles.comingSoonTitle}>No land listings yet</Text>
              <Text style={styles.comingSoonSub}>Check back soon for new listings</Text>
            </View>
          ) : (
            <View style={{
              position: 'absolute', top: 0, left: 0,
              width: SCREEN_WIDTH, height: SCREEN_HEIGHT,
            }}>
              <FlatList
                ref={flatListLandRef}
                data={landProperties}
                keyExtractor={(item) => String(item.id)}
                renderItem={({ item, index }) => (
                  <VideoSlide
                    item={item}
                    isActive={index === activeIndexLand}
                    isAdjacent={Math.abs(index - activeIndexLand) === 1}
                    screenWidth={SCREEN_WIDTH}
                    screenHeight={SCREEN_HEIGHT}
                    land
                    bottomInset={tabBarHeight}
                  />
                )}
                pagingEnabled
                showsVerticalScrollIndicator={false}
                snapToInterval={SCREEN_HEIGHT}
                snapToAlignment="start"
                decelerationRate="fast"
                onViewableItemsChanged={onViewableItemsChangedLand}
                viewabilityConfig={viewabilityConfig.current}
                windowSize={3}
                initialNumToRender={2}
                maxToRenderPerBatch={2}
                getItemLayout={(_, index) => ({
                  length: SCREEN_HEIGHT, offset: SCREEN_HEIGHT * index, index,
                })}
                refreshControl={
                  <RefreshControl
                    refreshing={refreshingLand}
                    onRefresh={onRefreshLand}
                    tintColor="#D4AF37"
                    colors={['#D4AF37']}
                  />
                }
              />
            </View>
          )}
        </>
      )}

      {/* Download progress — shared across RENT, PROPERTIES & LAND */}
      {downloading && (
        <View style={{
          position: 'absolute',
          bottom: 150,
          left: 16,
          backgroundColor: 'rgba(0,0,0,0.6)',
          borderRadius: 20,
          paddingHorizontal: 12,
          paddingVertical: 8,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          zIndex: 999,
        }}>
          <ActivityIndicator size="small" color="#D4AF37" />
          <Text style={{ color: '#fff', fontSize: 11, fontWeight: '700' }}>
            {downloadProgress > 0 ? `${downloadProgress}%` : 'Preparing...'}
          </Text>
        </View>
      )}

      {/* Right side action bar — shared across RENT, PROPERTIES & LAND.
          Bottom offset now includes the real tab bar height so CARE/
          SHARE/BOOK never sit underneath the HOME/BOOKINGS bar. */}
      <View style={[styles.bottomBar, { bottom: 8 + tabBarHeight }]}>
        <TouchableOpacity style={styles.actionBtn} onPress={() => setCareVisible(true)}>
          <View style={styles.actionIconCircle}><CareIcon /></View>
          <Text style={styles.actionBtnLabel}>CARE</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.actionBtn} onPress={() => setShareVisible(true)}>
          <View style={styles.actionIconCircle}><ShareIcon /></View>
          <Text style={styles.actionBtnLabel}>SHARE</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.actionBtn}
          onPress={() => {
            setBookingStep('idle');
            setBookingMode('pay_now');
            setBookVisible(true);
          }}
        >
          <View style={[styles.actionIconCircle, styles.bookIconCircle]}><BookIcon /></View>
          <Text style={[styles.actionBtnLabel, { color: '#D4AF37', fontWeight: '900' }]}>BOOK</Text>
        </TouchableOpacity>
      </View>

      {/* Top overlay */}
      <View style={[styles.topOverlay, { paddingTop: insets.top + 6 }]} pointerEvents="box-none">
        <View style={styles.topRow} pointerEvents="box-none">
          <TouchableOpacity style={styles.sortBtn} onPress={() => setSortOpen(o => !o)}>
            <Text style={styles.sortBtnText}>SORT</Text>
          </TouchableOpacity>
          <View style={styles.tabRow} pointerEvents="box-none">
            {(['RENT', 'LAND', 'PROPERTIES'] as const).map(tab => (
              <TouchableOpacity key={tab} onPress={() => setActiveTab(tab)} style={styles.tabItem}>
                <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>{tab}</Text>
                {activeTab === tab && <View style={styles.tabUnderline} />}
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {sortOpen && (
          <View style={styles.sortPanel}>
            <View style={styles.dropdownStack}>
              <View style={styles.dropdownItem}>
                <Text style={styles.dropdownLabel}>Region</Text>
                <View style={styles.dropdownBox}>
                  <Picker
                    mode="dropdown"
                    selectedValue={filters.region}
                    onValueChange={(val) => {
                      const newF = { ...filtersRef.current, region: val, district: '', subcounty: '' };
                      setFilters(newF); filtersRef.current = newF;
                      fetchDistricts(val);
                      setTimeout(() => {
  resetAndLoadActiveTab();
}, 300);
                    }}
                    style={styles.picker}
                    dropdownIconColor="#D4AF37"
                  >
                    <Picker.Item label="All Regions" value="" color="#999" />
                    {regions.map((r: any) => (
                      <Picker.Item key={r.id} label={r.name} value={r.name} color="#000" />
                    ))}
                  </Picker>
                </View>
              </View>
              <View style={styles.dropdownItem}>
                <Text style={styles.dropdownLabel}>District</Text>
                <View style={[styles.dropdownBox, districts.length === 0 && styles.dropdownDisabled]}>
                  <Picker
                    mode="dropdown"
                    selectedValue={filters.district}
                    onValueChange={(val) => {
                      const newF = { ...filtersRef.current, district: val, subcounty: '' };
                      setFilters(newF); filtersRef.current = newF;
                      fetchSubcounties(val);
                      setTimeout(() => {
  resetAndLoadActiveTab();
}, 300);
                    }}
                    style={styles.picker}
                    dropdownIconColor="#D4AF37"
                    enabled={districts.length > 0}
                  >
                    <Picker.Item label="All Districts" value="" color="#999" />
                    {districts.map((d: any) => (
                      <Picker.Item key={d.id} label={d.name} value={d.name} color="#000" />
                    ))}
                  </Picker>
                </View>
              </View>
              <View style={styles.dropdownItem}>
                <Text style={styles.dropdownLabel}>Subcounty</Text>
                <View style={[styles.dropdownBox, subcounties.length === 0 && styles.dropdownDisabled]}>
                  <Picker
                    mode="dropdown"
                    selectedValue={filters.subcounty}
                    onValueChange={(val) => {
                      const newF = { ...filtersRef.current, subcounty: val };
                      setFilters(newF); filtersRef.current = newF;
                      setTimeout(() => {
  resetAndLoadActiveTab();
}, 300);
                    }}
                    style={styles.picker}
                    dropdownIconColor="#D4AF37"
                    enabled={subcounties.length > 0}
                  >
                    <Picker.Item label="All Subcounties" value="" color="#999" />
                    {subcounties.map((s: any) => (
                      <Picker.Item key={s.id} label={s.name} value={s.name} color="#000" />
                    ))}
                  </Picker>
                </View>
              </View>
            </View>
            <View style={styles.priceRow}>
              {(['budget', 'mid', 'standard', 'premium'] as const).map(p => (
                <TouchableOpacity
                  key={p}
                  style={[styles.pricePill, filters.price === p && styles.pricePillActive]}
                  onPress={() => {
                    const newF = { ...filtersRef.current, price: p };
                    setFilters(newF); filtersRef.current = newF;
                    setTimeout(() => {
  resetAndLoadActiveTab();
}, 300);
                  }}
                >
                  {/* PROPERTIES and LAND share the same higher price bands
                      (sale/land prices are in the millions, unlike monthly
                      rent). RENT keeps its original thousands-based bands. */}
                  <Text
  style={[
    styles.pricePillText,
    filters.price === p && styles.pricePillTextActive,
  ]}
>
  {(activeTab === 'PROPERTIES' || activeTab === 'LAND')
    ? (p === 'budget'
        ? '< 10M'
        : p === 'mid'
        ? '10M–50M'
        : p === 'standard'
        ? '50M–100M'
        : '> 100M')
    : (p === 'budget'
        ? '< 200k'
        : p === 'mid'
        ? '200k–400k'
        : p === 'standard'
        ? '400k–600k'
        : '> 600k')}
</Text>

<Text
  style={[
    styles.pricePillSub,
    filters.price === p && styles.pricePillTextActive,
  ]}
>
  {p === 'budget'
    ? 'Budget'
    : p === 'mid'
    ? 'Mid-range'
    : p === 'standard'
    ? 'Standard'
    : 'Premium'}
</Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* ── SEARCH — last item in the sort panel. Type a village
                 name or an exact price. Only scrolls to a match if one
                 exists in what's already loaded; otherwise the person
                 stays exactly on the video they're watching. ── */}
            <View style={styles.searchRow}>
              <TextInput
                style={styles.searchInput}
                placeholder="Search village or exact price…"
                placeholderTextColor="#777"
                value={searchQuery}
                onChangeText={setSearchQuery}
                onSubmitEditing={handleSearch}
                returnKeyType="search"
              />
              <TouchableOpacity style={styles.searchBtn} onPress={handleSearch}>
                <Text style={styles.searchBtnText}>🔍</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </View>

      {/* BOOK MODAL */}
<Modal visible={bookVisible} transparent animationType="slide">
  <KeyboardAvoidingView
    behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    style={{ flex: 1 }}
  >
    <View style={styles.backdrop}>
      <View style={styles.sheet}>

        {/* Header */}
        <View style={styles.modalHeader}>
          <View style={styles.modalIconBadge}>
            <Text style={{ fontSize: 26 }}>🏠</Text>
          </View>

          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={styles.sheetTitle}>
              Book Inspection
            </Text>

            {currentProp && (
              <Text style={styles.sheetSub}>
                {currentProp.property_type} ·{' '}
                {activeTab === 'LAND'
                  ? formatUsage(currentProp.property_usage, true)
                  : currentProp.bedroom_type}{' '}
                · {currentProp.village}
              </Text>
            )}
          </View>
        </View>

        {/* Toggle — shown for RENT, PROPERTIES, and LAND alike. */}
        <View
          style={{
            flexDirection: 'row',
            backgroundColor: '#1a1a1a',
            borderRadius: 14,
            padding: 4,
            marginBottom: 16,
          }}
        >
          <TouchableOpacity
            onPress={() =>
              setBookingMode('pay_now')
            }
            style={{
              flex: 1,
              paddingVertical: 12,
              borderRadius: 12,
              alignItems: 'center',
              backgroundColor:
                bookingMode === 'pay_now'
                  ? '#D4AF37'
                  : 'transparent',
            }}
          >
            <Text
              style={{
                fontWeight: '800',
                color:
                  bookingMode === 'pay_now'
                    ? '#000'
                    : '#fff',
              }}
            >
              PAY NOW
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() =>
              setBookingMode('pay_after')
            }
            style={{
              flex: 1,
              paddingVertical: 12,
              borderRadius: 12,
              alignItems: 'center',
              backgroundColor:
                bookingMode === 'pay_after'
                  ? '#D4AF37'
                  : 'transparent',
            }}
          >
            <Text
              style={{
                fontWeight: '800',
                color:
                  bookingMode === 'pay_after'
                    ? '#000'
                    : '#fff',
              }}
            >
              PAY AFTER VISIT
            </Text>
          </TouchableOpacity>
        </View>

        {/* Broker fee */}
        {currentProp && (
          <View style={styles.feeBox}>
            <Text style={styles.feeLabel}>
              Broker Fee
            </Text>

            <Text style={styles.feeValue}>
              UGX {currentProp.broker_fee}
            </Text>
          </View>
        )}

        {/* PAY NOW FLOW */}
        {bookingMode === 'pay_now' ? (
          <>
            <TextInput
              style={styles.input}
              placeholder="Your full name"
              placeholderTextColor="#555"
              value={guestName}
              onChangeText={setGuestName}
            />

            <TextInput
              style={styles.input}
              placeholder="Phone number (07XXXXXXXX)"
              placeholderTextColor="#555"
              value={phone}
              onChangeText={setPhone}
              keyboardType="phone-pad"
            />

            <View style={styles.row}>
              {bookingStep !== 'verify' ? (
                <TouchableOpacity
                  style={[
                    styles.btn,
                    styles.proceedBtn,
                  ]}
                  onPress={handleProceed}
                  disabled={
                    bookingStep === 'pending'
                  }
                >
                  <Text style={styles.btnIcon}>
                    💳
                  </Text>

                  <Text style={styles.btnText}>
                    {bookingStep ===
                    'pending'
                      ? 'Processing…'
                      : 'Proceed'}
                  </Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  style={[
                    styles.btn,
                    styles.verifyBtn,
                    verifying && {
                      opacity: 0.6,
                    },
                  ]}
                  onPress={handleVerify}
                  disabled={verifying}
                >
                  <Text style={styles.btnIcon}>
                    ✅
                  </Text>

                  <Text style={styles.btnText}>
                    {verifying
                      ? 'Verifying…'
                      : 'Verify Payment'}
                  </Text>
                </TouchableOpacity>
              )}

              <TouchableOpacity
                style={[
                  styles.btn,
                  styles.cancelBtn,
                ]}
                onPress={closeBookModal}
              >
                <Text style={styles.btnIcon}>
                  ✕
                </Text>

                <Text style={styles.btnText}>
                  Cancel
                </Text>
              </TouchableOpacity>
            </View>
          </>
        ) : (
          <>
            {/* Date */}
            <TouchableOpacity
              style={styles.input}
              onPress={() =>
                setShowDatePicker(true)
              }
            >
              <Text
                style={{
                  color: '#fff',
                  fontSize: 14,
                }}
              >
                Visit Date:{' '}
                {visitDate.toDateString()}
              </Text>
            </TouchableOpacity>

            {showDatePicker && (
              <DateTimePicker
                value={visitDate}
                mode="date"
                minimumDate={new Date()}
                onChange={(e, date) => {
                  setShowDatePicker(false);

                  if (date) {
                    setVisitDate(date);
                  }
                }}
              />
            )}

            {/* Time slot */}
            <View
              style={{
                flexDirection: 'row',
                gap: 8,
                marginBottom: 12,
              }}
            >
              {[
                'morning',
                'afternoon',
                'evening',
              ].map(slot => (
                <TouchableOpacity
                  key={slot}
                  onPress={() =>
                    setVisitTimeSlot(
                      slot as any
                    )
                  }
                  style={{
                    flex: 1,
                    paddingVertical: 12,
                    borderRadius: 12,
                    alignItems: 'center',
                    backgroundColor:
                      visitTimeSlot === slot
                        ? '#D4AF37'
                        : '#1a1a1a',
                  }}
                >
                  <Text
                    style={{
                      fontWeight: '700',
                      color:
                        visitTimeSlot ===
                        slot
                          ? '#000'
                          : '#fff',
                    }}
                  >
                    {slot.toUpperCase()}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Name */}
            <TextInput
              style={styles.input}
              placeholder="Your full name"
              placeholderTextColor="#555"
              value={guestName}
              onChangeText={setGuestName}
            />

            {/* Phone */}
            <TextInput
              style={styles.input}
              placeholder="Phone number (07XXXXXXXX)"
              placeholderTextColor="#555"
              value={phone}
              onChangeText={setPhone}
              keyboardType="phone-pad"
            />

            {/* Helper text */}
            <Text
              style={{
                color: '#888',
                fontSize: 12,
                marginBottom: 14,
                textAlign: 'center',
              }}
            >
              Prefer to inspect before
              payment? Choose a date and
              time. Customer care will
              connect you to the
              respective property agent.
            </Text>

            <View style={styles.row}>
              <TouchableOpacity
                style={[
                  styles.btn,
                  styles.proceedBtn,
                ]}
                onPress={
                  handleScheduleVisit
                }
              >
                <Text style={styles.btnIcon}>
                  📅
                </Text>

                <Text style={styles.btnText}>
                  Schedule Visit
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.btn,
                  styles.cancelBtn,
                ]}
                onPress={closeBookModal}
              >
                <Text style={styles.btnIcon}>
                  ✕
                </Text>

                <Text style={styles.btnText}>
                  Cancel
                </Text>
              </TouchableOpacity>
            </View>
          </>
        )}
      </View>
    </View>
  </KeyboardAvoidingView>
</Modal>

      {/* SHARE MODAL */}
      <Modal visible={shareVisible} transparent animationType="fade">
        <View style={styles.backdrop}>
          <View style={styles.sheet}>
            <View style={styles.modalHeader}>
              <View style={styles.modalIconBadge}>
                <Text style={{ fontSize: 26 }}>🔗</Text>
              </View>
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={styles.sheetTitle}>Share Property</Text>
                {currentProp && (
                  <Text style={styles.sheetSub}>
                    {currentProp.property_type} ·{' '}
                    {activeTab === 'LAND'
                      ? formatUsage(currentProp.property_usage, true)
                      : currentProp.bedroom_type}{' '}
                    · {currentProp.village}
                  </Text>
                )}
              </View>
            </View>
            <Text style={styles.queryLabel}>Share via</Text>
            <TouchableOpacity style={styles.shareOptionBtn} onPress={handleShare}>
              <View style={[styles.shareOptionIcon, {
                backgroundColor: 'rgba(37,211,102,0.15)',
                borderColor: 'rgba(37,211,102,0.3)',
              }]}>
                <Text style={{ fontSize: 22 }}>📤</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.shareOptionTitle}>Share Link</Text>
                <Text style={styles.shareOptionSub}>Send via WhatsApp, SMS, email & more</Text>
              </View>
              <Text style={styles.shareOptionArrow}>›</Text>
            </TouchableOpacity>
            <View style={styles.divider} />
            <Text style={styles.queryLabel}>Save video</Text>
            <TouchableOpacity style={styles.shareOptionBtn} onPress={handleDownloadVideo}>
              <View style={[styles.shareOptionIcon, {
                backgroundColor: 'rgba(212,175,55,0.15)',
                borderColor: 'rgba(212,175,55,0.3)',
              }]}>
                <Text style={{ fontSize: 22 }}>⬇️</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.shareOptionTitle}>Download Video</Text>
                <Text style={styles.shareOptionSub}>Save this property video to your phone</Text>
              </View>
              <Text style={styles.shareOptionArrow}>›</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btn, styles.cancelBtn, { marginTop: 16, borderColor: '#fff', borderWidth: 1.5 }]}
              onPress={() => setShareVisible(false)}
            >
              <Text style={styles.btnIcon}>✕</Text>
              <Text style={[styles.btnText, { color: '#fff' }]}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* CUSTOMER CARE MODAL */}
      <Modal visible={careVisible} transparent animationType="slide">
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={{ flex: 1 }}
        >
          <View style={styles.backdrop}>
            <View style={styles.sheet}>
              <View style={styles.modalHeader}>
                <View style={styles.modalIconBadge}>
                  <Text style={{ fontSize: 26 }}>💬</Text>
                </View>
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={styles.sheetTitle}>Customer Care</Text>
                  <Text style={styles.sheetSub}>We're here to help you</Text>
                </View>
              </View>
              <View style={styles.careCallRow}>
                <TouchableOpacity
                  style={[styles.careCallBtn, { borderColor: '#E53935' }]}
                  onPress={() => handleCall('AIRTEL')}
                >
                  <Text style={styles.careCallIcon}>📞</Text>
                  <View>
                    <Text style={styles.careCallNetwork}>Airtel</Text>
                    <Text style={styles.careCallNumber}>+256 705 679 012</Text>
                  </View>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.careCallBtn, { borderColor: '#FFB300' }]}
                  onPress={() => handleCall('MTN')}
                >
                  <Text style={styles.careCallIcon}>📞</Text>
                  <View>
                    <Text style={styles.careCallNetwork}>MTN</Text>
                    <Text style={styles.careCallNumber}>+256 784 160 679</Text>
                  </View>
                </TouchableOpacity>
              </View>
              <TouchableOpacity style={styles.emailBtn} onPress={handleEmail}>
                <Text style={styles.careCallIcon}>✉️</Text>
                <View>
                  <Text style={styles.careCallNetwork}>Email Us</Text>
                  <Text style={styles.careCallNumber}>openbrokka@gmail.com</Text>
                </View>
              </TouchableOpacity>
              <View style={styles.divider} />
              <Text style={styles.queryLabel}>Or leave us a message</Text>
              <TextInput
                style={styles.input}
                placeholder="Your query…"
                placeholderTextColor="#555"
                value={queryText}
                onChangeText={setQueryText}
                multiline
                numberOfLines={3}
              />
              <TextInput
                style={styles.input}
                placeholder="Your phone number"
                placeholderTextColor="#555"
                value={queryPhone}
                onChangeText={setQueryPhone}
                keyboardType="phone-pad"
              />
              <View style={styles.row}>
                <TouchableOpacity style={[styles.btn, styles.proceedBtn]} onPress={submitQuery}>
                  <Text style={styles.btnIcon}>📨</Text>
                  <Text style={styles.btnText}>Submit</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.btn, styles.cancelBtn]} onPress={() => setCareVisible(false)}>
                  <Text style={styles.btnIcon}>✕</Text>
                  <Text style={styles.btnText}>Close</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root:       { flex: 1, backgroundColor: '#000' },
  loader:     { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 },
  loaderText: { color: '#D4AF37', fontSize: 14, letterSpacing: 1 },
  pausePill: {
    position: 'absolute', top: '45%', alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.4)',
    paddingHorizontal: 20, paddingVertical: 8, borderRadius: 20,
  },
  pausePillText: { color: 'rgba(255,255,255,0.85)', fontSize: 13, fontWeight: '600' },
  propInfo: { position: 'absolute', bottom: 47, left: 14, maxWidth: '65%', gap: 3 },
  propType: {
    color: '#fff', fontSize: 15, fontWeight: '800',
    textShadowColor: 'rgba(0,0,0,0.95)', textShadowOffset: { width: 1, height: 1 }, textShadowRadius: 6,
  },
  propPrice: {
    color: '#D4AF37', fontSize: 15, fontWeight: '800',
    textShadowColor: 'rgba(0,0,0,0.95)', textShadowOffset: { width: 1, height: 1 }, textShadowRadius: 6,
  },
  propMeta: {
    color: '#fff', fontSize: 12,
    textShadowColor: 'rgba(0,0,0,0.95)', textShadowOffset: { width: 1, height: 1 }, textShadowRadius: 6,
  },
  topOverlay: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 100 },
  topRow:     { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, gap: 12 },
  sortBtn: {
    borderWidth: 2, borderColor: '#D4AF37', borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 6, backgroundColor: 'rgba(0,0,0,0.6)',
  },
  sortBtnText:   { color: '#fff', fontWeight: '900', fontSize: 14, letterSpacing: 1 },
  tabRow:        { flexDirection: 'row', gap: 20, flex: 1, justifyContent: 'center' },
  tabItem:       { alignItems: 'center' },
  tabText: {
    color: 'rgba(255,255,255,0.45)', fontSize: 15, fontWeight: '700', letterSpacing: 1,
    textShadowColor: 'rgba(0,0,0,0.9)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3,
  },
  tabTextActive: { color: '#fff', fontSize: 16 },
  tabUnderline:  { marginTop: 3, height: 2, width: '100%', backgroundColor: '#D4AF37', borderRadius: 2 },
  sortPanel: {
    marginTop: 8, marginHorizontal: 10,
    backgroundColor: 'rgba(0,0,0,0.82)',
    borderRadius: 16, padding: 14, gap: 12,
    borderWidth: 1, borderColor: 'rgba(212,175,55,0.25)',
  },
  dropdownStack:    { gap: 8 },
  dropdownItem:     { gap: 4 },
  dropdownLabel: {
    color: '#D4AF37', fontSize: 11, fontWeight: '800',
    letterSpacing: 1, textTransform: 'uppercase', marginLeft: 4,
  },
  dropdownBox: {
    backgroundColor: '#fff', borderRadius: 10,
    overflow: 'hidden', height: 48, justifyContent: 'center',
  },
  dropdownDisabled: { backgroundColor: '#2a2a2a', opacity: 0.5 },
  picker:           { height: 48, color: '#000' },
  priceRow: { flexDirection: 'row', gap: 8 },
  pricePill: {
    flex: 1, paddingVertical: 10, borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)',
  },
  pricePillActive:     { backgroundColor: '#D4AF37', borderColor: '#D4AF37' },
  pricePillText:       { color: '#fff', fontSize: 12, fontWeight: '800', textAlign: 'center' },
  pricePillSub:        { color: 'rgba(255,255,255,0.6)', fontSize: 10, textAlign: 'center', marginTop: 2 },
  pricePillTextActive: { color: '#000' },
  // ── Search row (last item in sort panel) ──
  searchRow: {
    flexDirection: 'row', gap: 8, marginTop: 2,
  },
  searchInput: {
    flex: 1, backgroundColor: '#1a1a1a', borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10, color: '#fff', fontSize: 13,
    borderWidth: 1, borderColor: 'rgba(212,175,55,0.25)',
  },
  searchBtn: {
    backgroundColor: '#D4AF37', borderRadius: 10,
    paddingHorizontal: 16, justifyContent: 'center', alignItems: 'center',
  },
  searchBtnText: { fontSize: 16 },
  comingSoon:      { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 },
  comingSoonEmoji: { fontSize: 54 },
  comingSoonTitle: { color: '#fff', fontSize: 22, fontWeight: '800' },
  comingSoonSub:   { color: '#555', fontSize: 14 },
  bottomBar: {
    position: 'absolute', right: 14,
    flexDirection: 'column', alignItems: 'center',
    backgroundColor: 'transparent', gap: 18, zIndex: 50,
  },
  actionBtn:        { alignItems: 'center', gap: 6 },
  actionIconCircle: {
    width: 52, height: 52, borderRadius: 26,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center', justifyContent: 'center',
  },
  bookIconCircle: {
    backgroundColor: '#D4AF37', borderColor: '#D4AF37',
    shadowColor: '#D4AF37', shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6, shadowRadius: 10, elevation: 8,
  },
  actionBtnLabel: { color: 'rgba(255,255,255,0.85)', fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.0)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#111',
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: 24, paddingBottom: 40,
    borderTopWidth: 1, borderColor: 'rgba(212,175,55,0.2)',
  },
  modalHeader:    { flexDirection: 'row', alignItems: 'center', marginBottom: 18 },
  modalIconBadge: {
    width: 52, height: 52, borderRadius: 14,
    backgroundColor: 'rgba(212,175,55,0.15)',
    borderWidth: 1, borderColor: 'rgba(212,175,55,0.3)',
    alignItems: 'center', justifyContent: 'center',
  },
  sheetTitle: { color: '#fff', fontSize: 18, fontWeight: '800' },
  sheetSub:   { color: '#888', fontSize: 12, marginTop: 2 },
  feeBox: {
    backgroundColor: 'rgba(212,175,55,0.1)', borderRadius: 10, padding: 12, marginBottom: 14,
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    borderWidth: 1, borderColor: 'rgba(212,175,55,0.25)',
  },
  feeLabel: { color: '#aaa', fontSize: 12, fontWeight: '600' },
  feeValue: { color: '#D4AF37', fontSize: 15, fontWeight: '900' },
  input: {
    backgroundColor: '#1a1a1a', borderRadius: 12, color: '#fff',
    padding: 14, fontSize: 14, marginBottom: 10,
    borderWidth: 1, borderColor: '#2a2a2a',
  },
  row:        { flexDirection: 'row', gap: 10, marginTop: 6 },
  btn: {
    flex: 1, paddingVertical: 14, borderRadius: 14,
    alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 6,
  },
  btnText:    { color: '#fff', fontWeight: '700', fontSize: 14 },
  btnIcon:    { fontSize: 16 },
  proceedBtn: { backgroundColor: '#8B4513' },
  verifyBtn:  { backgroundColor: '#16a34a' },
  cancelBtn:  { backgroundColor: '#000', borderWidth: 1, borderColor: '#fff' },
  shareOptionBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    backgroundColor: '#1a1a1a', borderRadius: 14, padding: 14,
    marginBottom: 10, borderWidth: 1, borderColor: '#2a2a2a',
  },
  shareOptionIcon: {
    width: 48, height: 48, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1,
  },
  shareOptionTitle: { color: '#fff', fontSize: 14, fontWeight: '800' },
  shareOptionSub:   { color: '#666', fontSize: 11, marginTop: 2 },
  shareOptionArrow: { color: '#555', fontSize: 22, fontWeight: '300' },
  careCallRow: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  careCallBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: '#1a1a1a', borderRadius: 14, padding: 14, borderWidth: 1.5,
  },
  emailBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: '#1a1a1a', borderRadius: 14, padding: 14,
    borderWidth: 1.5, borderColor: '#1565C0', marginBottom: 10,
  },
  careCallIcon:    { fontSize: 22 },
  careCallNetwork: { color: '#fff', fontSize: 13, fontWeight: '800' },
  careCallNumber:  { color: '#888', fontSize: 11, marginTop: 2 },
  divider:    { height: 1, backgroundColor: 'rgba(255,255,255,0.08)', marginVertical: 14 },
  queryLabel: {
    color: '#aaa', fontSize: 12, fontWeight: '700',
    letterSpacing: 0.5, marginBottom: 8, textTransform: 'uppercase',
  },
});
