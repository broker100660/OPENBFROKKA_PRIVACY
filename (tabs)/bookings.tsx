import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Image,
  Alert,
  Linking,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { API_URL } from '../../config/api';
import messaging from '@react-native-firebase/messaging';

const GUEST_KEY = 'guest_id';
const THREE_HOURS_MS = 3 * 60 * 60 * 1000;

// ─── Category tabs ───
type CategoryType = 'RENT' | 'LAND' | 'PROPERTIES';

// Same convention as the broker screen: bookings are told apart by `booking_type`.
// Rent bookings have booking_type undefined/null or 'rent'. Property-for-sale
// bookings are tagged 'property_sale'.
const SCHEDULED_VISIT_TYPE = 'scheduled_visit';

// The real signal for which category an item belongs to is which foreign key
// is populated: property_for_sale_id → PROPERTIES, land_property_id → LAND,
// property_id (and neither of the above) → RENT. booking_type only tells us
// paid vs scheduled_visit, not the category — a scheduled visit for a
// for-sale or land property still has booking_type "scheduled_visit", so it
// can't be used to separate categories.
const getItemCategory = (item: any): CategoryType => {
  if (item?.property_for_sale_id != null) return 'PROPERTIES';
  if (item?.land_property_id != null) return 'LAND';
  return 'RENT';
};

// NOTE: Exact GPS coordinates and landlord/owner contact details are
// intentionally NOT shown to clients — that's broker-only information.
// Clients only see the broker's phone number and coordinate location/
// logistics through them. This applies the same way to LAND (owner
// details stay broker-only, same as landlord details for RENT/PROPERTIES).

// Human-readable property_usage label for land listings
// (rentals_apartments/residence/shops → readable text).
const formatLandUsage = (usage: string | undefined): string => {
  if (!usage) return 'N/A';
  if (usage === 'rentals_apartments') return 'For rentals/apartments';
  if (usage === 'residence') return 'Residence';
  if (usage === 'shops') return 'Shops';
  return usage;
};

// Title line helper — LAND has no bedroom_type, so show property_usage
// instead. RENT/PROPERTIES keep the original property_type · bedroom_type.
const titleLine = (property: any, category: CategoryType) =>
  category === 'LAND'
    ? `${property?.property_type || 'Land'} · ${formatLandUsage(property?.property_usage)}`
    : `${property?.property_type || 'Property'} · ${property?.bedroom_type || 'N/A'}`;

// ─── Countdown clock ───
function CountdownClock({ bookedAt }: { bookedAt: string }) {
  const getRemaining = () => {
    if (!bookedAt) return 0;
    const elapsed = Date.now() - new Date(bookedAt).getTime();
    const remaining = THREE_HOURS_MS - elapsed;
    return remaining > 0 ? remaining : 0;
  };

  const [remaining, setRemaining] = useState(getRemaining());

  useEffect(() => {
    setRemaining(getRemaining()); // reset when bookedAt changes

    const interval = setInterval(() => {
      const r = getRemaining();
      setRemaining(r);
      if (r <= 0) clearInterval(interval);
    }, 1000);
    return () => clearInterval(interval);
  }, [bookedAt]);

  const hours   = Math.floor(remaining / (1000 * 60 * 60));
  const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((remaining % (1000 * 60)) / 1000);
  const isExpired = remaining <= 0;
  const isUrgent  = remaining < 30 * 60 * 1000;
  const pad = (n: number) => String(n).padStart(2, '0');

  return (
    <View style={[
      clockStyles.container,
      isExpired ? clockStyles.expired : isUrgent ? clockStyles.urgent : clockStyles.normal,
    ]}>
      <Text style={clockStyles.label}>⏱ SLOT</Text>
      <Text style={[
        clockStyles.time,
        isExpired ? clockStyles.expiredText : isUrgent ? clockStyles.urgentText : clockStyles.normalText,
      ]}>
        {isExpired ? 'EXPIRED' : `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`}
      </Text>
    </View>
  );
}

const clockStyles = StyleSheet.create({
  container: {
    borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6,
    alignItems: 'center', borderWidth: 1,
  },
  normal:  { backgroundColor: 'rgba(212,175,55,0.1)', borderColor: 'rgba(212,175,55,0.3)' },
  urgent:  { backgroundColor: 'rgba(255,80,80,0.1)',  borderColor: 'rgba(255,80,80,0.4)'  },
  expired: { backgroundColor: 'rgba(80,80,80,0.2)',  borderColor: 'rgba(80,80,80,0.3)'   },
  label: {
    fontSize: 9, fontWeight: '800', color: '#666',
    letterSpacing: 1, textTransform: 'uppercase', marginBottom: 2,
  },
  time:        { fontSize: 14, fontWeight: '900', letterSpacing: 1 },
  normalText:  { color: '#D4AF37' },
  urgentText:  { color: '#FF5050' },
  expiredText: { color: '#555' },
});

// ─── Inline video ───
function PropertyVideo({ streamId }: { streamId: string }) {
  return (
    <WebView
      style={styles.video}
      source={{ uri: `https://iframe.videodelivery.net/${streamId}?autoplay=true` }}
      allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction={false}
    />
  );
}

// ─── Review Questions ───
// Shared by both paid bookings and pay-after visits — reviewId is the
// review_questions row's own id either way, and the answer endpoint
// figures out booking vs visit internally, so nothing here needs to know
// which type of item it's attached to.
function ReviewQuestions({ questions, bookingId }: { questions: any[], bookingId: number }) {
  const [answers, setAnswers] = useState<{ [key: number]: string }>({});
  const [submitting, setSubmitting] = useState<number | null>(null);

  const pending  = questions?.filter(q => q.status === 'pending') || [];
  const answered = questions?.filter(q => q.status === 'answered') || [];

  if (pending.length === 0 && answered.length === 0) return null;

  const handleAnswer = async (questionId: number, answer: string) => {
    setSubmitting(questionId);
    try {
      const res = await fetch(`${API_URL}/api/bookings/review/${questionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer }),
      });
      if (res.ok) {
        setAnswers(prev => ({ ...prev, [questionId]: answer }));
      } else {
        Alert.alert('Already answered');
      }
    } catch {
      Alert.alert('Error', 'Could not submit answer');
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <View style={reviewStyles.container}>
      <Text style={reviewStyles.title}>⭐ Review Questions</Text>
      {questions.map((q: any) => {
        const isAnswered = q.status === 'answered' || answers[q.id];
        const givenAnswer = answers[q.id] || q.answer;
        return (
          <View key={q.id} style={reviewStyles.questionBox}>
            <Text style={reviewStyles.question}>{q.question}</Text>
            {isAnswered ? (
              <Text style={[
                reviewStyles.answeredBadge,
                givenAnswer === 'yes' ? reviewStyles.yes : reviewStyles.no,
              ]}>
                {givenAnswer === 'yes' ? '✅ Yes' : '❌ No'}
              </Text>
            ) : (
              <View style={reviewStyles.btnRow}>
                <TouchableOpacity
                  style={[reviewStyles.btn, reviewStyles.yesBtn]}
                  disabled={submitting === q.id}
                  onPress={() => handleAnswer(q.id, 'yes')}
                >
                  <Text style={reviewStyles.btnText}>
                    {submitting === q.id ? '...' : '😊 Yes'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[reviewStyles.btn, reviewStyles.noBtn]}
                  disabled={submitting === q.id}
                  onPress={() => handleAnswer(q.id, 'no')}
                >
                  <Text style={reviewStyles.btnText}>
                    {submitting === q.id ? '...' : '😞 No'}
                  </Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

const reviewStyles = StyleSheet.create({
  container: {
    margin: 14, padding: 14, backgroundColor: '#1a1a1a',
    borderRadius: 14, borderWidth: 1, borderColor: 'rgba(212,175,55,0.2)',
  },
  title: {
    color: '#D4AF37', fontSize: 13, fontWeight: '800',
    letterSpacing: 1, marginBottom: 12, textTransform: 'uppercase',
  },
  questionBox: { marginBottom: 12 },
  question:    { color: '#ccc', fontSize: 13, marginBottom: 8 },
  btnRow:      { flexDirection: 'row', gap: 8 },
  btn: { flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center' },
  yesBtn: { backgroundColor: 'rgba(76,175,80,0.2)', borderWidth: 1, borderColor: '#4CAF50' },
  noBtn:  { backgroundColor: 'rgba(244,67,54,0.2)', borderWidth: 1, borderColor: '#F44336' },
  btnText:       { color: '#fff', fontWeight: '700', fontSize: 13 },
  answeredBadge: { fontSize: 13, fontWeight: '800' },
  yes: { color: '#4CAF50' },
  no:  { color: '#F44336' },
});

// ─── Active booking card (used for RENT, PROPERTIES, and LAND) ───
// Pay-now bookings only — unchanged from before.
function ActiveBookingCard({ item, playingId, setPlayingId, guestId, fetchBookings, category }: any) {
  const property    = item?.properties;
  const videoUrl    = property?.video_url || '';
  const streamId    = videoUrl ? videoUrl.split('/')[3] : null;
  const thumbnail   = streamId
    ? `https://videodelivery.net/${streamId}/thumbnails/thumbnail.jpg?time=0`
    : null;
  const isPlaying   = playingId === item?.id;
  const hasStarted  = item?.booking_statuses?.some((s: any) => s.status === 'started');
  const brokerPhone = item?.broker_phone || null;

  const formatDate = (dateStr: string) => {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-UG', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  };

  const handleStartVisit = () => {
    Alert.alert(
      'Start Visit',
      'Confirm you are starting this property visit now?',
      [
        { text: 'Not yet', style: 'cancel' },
        {
          text: 'Start Visit',
          onPress: async () => {
            try {
              const res = await fetch(`${API_URL}/api/booking-statuses/start`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  booking_id: item.id,
                  actor_type: 'client',
                  actor_id: guestId,
                }),
              });
              if (res.ok) {
                Alert.alert('✅ Visit started!', 'Your broker has been notified.');
                fetchBookings();
              } else {
                const data = await res.json();
                Alert.alert('Failed', data?.error || 'Could not start visit.');
              }
            } catch {
              Alert.alert('Error', 'Could not connect to server.');
            }
          },
        },
      ]
    );
  };

  return (
    <View style={styles.card}>
      {isPlaying && streamId ? (
        <PropertyVideo streamId={streamId} />
      ) : (
        <TouchableOpacity activeOpacity={0.85} onPress={() => streamId && setPlayingId(item.id)}>
          {thumbnail ? (
            <View>
              <Image source={{ uri: thumbnail }} style={styles.thumbnail} resizeMode="cover" />
              <View style={styles.playOverlay}>
                <View style={styles.playBtn}>
                  <Text style={styles.playIcon}>▶</Text>
                </View>
              </View>
            </View>
          ) : (
            <View style={styles.thumbnailPlaceholder}>
              <Text style={styles.thumbnailPlaceholderText}>🏠</Text>
            </View>
          )}
        </TouchableOpacity>
      )}

      <View style={styles.details}>
        <Text style={styles.propertyType}>{titleLine(property, category)}</Text>
        <Text style={styles.detail}>📍 {property?.village}</Text>
        <Text style={styles.detail}>💰 UGX {property?.price}</Text>
        <Text style={styles.detail}>🚌 {property?.transport_to_town}</Text>
        <Text style={styles.detail}>🛣  {property?.to_main_road}</Text>
        <View style={styles.divider} />
        <Text style={styles.sectionLabel}>Your Booking</Text>
        <Text style={styles.detail}>🕐 Booked: {formatDate(item?.booked_at)}</Text>
        <Text style={styles.detail}>
          📋 Status:{' '}
          <Text style={[styles.statusBadge, hasStarted ? styles.statusStarted : styles.statusPending]}>
            {hasStarted ? ' Visit Started ' : ' Pending '}
          </Text>
        </Text>
        {property?.broker_fee && (
          <Text style={styles.detail}>🏷 Broker Fee: UGX {property.broker_fee}</Text>
        )}
        {item?.booked_at && !hasStarted && (
          <View style={styles.clockRow}>
            <Text style={styles.clockHint}>VIDEO TO BE PLACED BACK FOR BOOKING IN:</Text>
            <CountdownClock bookedAt={item.booked_at} />
          </View>
        )}
      </View>

      <View style={styles.actions}>
        {brokerPhone && (
          <TouchableOpacity style={styles.callBtn} onPress={() => Linking.openURL(`tel:${brokerPhone}`)}>
            <Text style={styles.callBtnText}>📞  Call Broker</Text>
          </TouchableOpacity>
        )}
        {!hasStarted && (
          <>
            <Text style={styles.visitHint}>
              📌 Only press{' '}
              <Text style={{ color: '#D4AF37', fontWeight: '900' }}>Start Visit</Text>
              {' '}when you are physically at the property with the broker.
            </Text>
            <TouchableOpacity style={styles.startVisitBtn} onPress={handleStartVisit}>
              <Text style={styles.startVisitText}>🚀  Start Visit</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </View>
  );
}

// ─── Scheduled Inspection Card (Pay-After-Visit) ───
// Client sees this from the moment they schedule a visit through to the
// moment they end + pay. Three states shown here:
//   1. pending  — waiting for broker to tap "Start Meeting"
//   2. started  — client is physically at the visit; "End Meeting" is live
//   3. (ended visits move out of this card entirely — they render via
//      EndedBookingCard once payment_status is 'paid')
function ScheduledVisitCard({ item, category, guestId, fetchBookings }: any) {
  const property = item?.properties;
  // For-sale and land visits could still come back with `properties: null`
  // if the backend property lookup ever fails — show this clearly instead
  // of silently rendering blank dashes for every field.
  const isMissingPropertyData =
    (item?.property_for_sale_id != null || item?.land_property_id != null) && !property;

  const isPending = item?.status === 'pending' || !item?.status;
  const isStarted = item?.status === 'started' || item?.status === 'ongoing';

  const [payStep, setPayStep] = useState<'idle' | 'pending' | 'verify'>('idle');
  const [verifying, setVerifying] = useState(false);
  const [payRef, setPayRef] = useState<string | null>(null);

  const formatDate = (dateStr: string) => {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString('en-UG', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  };

  const handleEndMeeting = () => {
    Alert.alert(
      'End Meeting',
      'This will charge the broker fee for this visit. Confirm you are ending the meeting now?',
      [
        { text: 'Not yet', style: 'cancel' },
        {
          text: 'End & Pay',
          onPress: async () => {
            setPayStep('pending');
            try {
              const res = await fetch(`${API_URL}/api/visits/payments/initiate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  visit_id: item.id,
                  phone: item.phone,
                  name: item.guest_name || item.name,
                  guest_id: guestId,
                }),
              });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error);
              setPayRef(data.external_ref || null);
              setPayStep('verify');
              Alert.alert('Payment sent', 'Complete payment on your phone then tap Verify.');
            } catch (err: any) {
              Alert.alert('Error', err.message || 'Could not start payment.');
              setPayStep('idle');
            }
          },
        },
      ]
    );
  };

  const handleVerifyPayment = async () => {
    if (!payRef) { Alert.alert('Tap End Meeting first.'); return; }
    if (verifying) return;
    setVerifying(true);
    try {
      const res = await fetch(`${API_URL}/api/visits/payments/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction_id: payRef }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setPayStep('idle');
      setPayRef(null);
      Alert.alert('✅ Visit ended & paid!', 'Please answer the review questions once they appear below.');
      fetchBookings();
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Verification failed');
    } finally {
      setVerifying(false);
    }
  };

  return (
    <View style={styles.card}>
      <View style={styles.details}>
        {isMissingPropertyData ? (
          <Text style={styles.missingDataNotice}>
            ⚠️ Property details unavailable for this listing
          </Text>
        ) : (
          <>
            <Text style={styles.propertyType}>{titleLine(property, category)}</Text>
            <Text style={styles.detail}>📍 {property?.village || 'Unknown Location'}</Text>
            <Text style={styles.detail}>💰 UGX {property?.price || '—'}</Text>
            {property?.broker_fee && (
              <Text style={styles.detail}>🏷 Broker Fee: UGX {property.broker_fee}</Text>
            )}
          </>
        )}

        <View style={styles.divider} />

        <Text style={styles.sectionLabel}>Scheduled Inspection</Text>

        <Text style={styles.detail}>📅 Date: {formatDate(item?.preferred_date)}</Text>
        <Text style={styles.detail}>🕒 Time: {item?.preferred_time_slot || '—'}</Text>
        <Text style={styles.detail}>📞 Contact: {item?.phone || '—'}</Text>
        <Text style={styles.detail}>
          📋 Status:{' '}
          <Text style={[styles.statusBadge, isStarted ? styles.statusStarted : styles.statusPending]}>
            {isPending ? ' Waiting for broker to start ' : ' Visit in progress '}
          </Text>
        </Text>
      </View>

      {isStarted && (
        <View style={styles.actions}>
          <Text style={styles.visitHint}>
            📌 Only press{' '}
            <Text style={{ color: '#D4AF37', fontWeight: '900' }}>End Meeting</Text>
            {' '}once your inspection with the broker is complete.
          </Text>

          {payStep !== 'verify' ? (
            <TouchableOpacity
              style={styles.endMeetingBtn}
              onPress={handleEndMeeting}
              disabled={payStep === 'pending'}
            >
              <Text style={styles.endMeetingBtnText}>
                {payStep === 'pending' ? 'Processing…' : '🔴  End Meeting & Pay'}
              </Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[styles.verifyBtn, verifying && { opacity: 0.6 }]}
              onPress={handleVerifyPayment}
              disabled={verifying}
            >
              <Text style={styles.verifyBtnText}>
                {verifying ? 'Verifying…' : '✅  Verify Payment'}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      )}
    </View>
  );
}

// ─── Ended booking/visit card ───
// Handles both ended pay-now bookings and ended (paid) pay-after visits.
// Visits are told apart from bookings by the presence of `preferred_date`,
// a field only visit_requests rows carry.
function EndedBookingCard({ item, category }: any) {
  const property        = item?.properties;
  const reviewQuestions = item?.review_questions || [];
  const isVisit          = item?.preferred_date !== undefined;

  const formatDate = (dateStr: string) => {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-UG', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  };

  const timeLabel = isVisit ? (item?.ended_at || item?.booked_at) : item?.booked_at;

  return (
    <View style={[styles.card, styles.cardEnded]}>
      <View style={styles.endedHeader}>
        <View>
          <Text style={styles.endedTitle}>{titleLine(property, category)}</Text>
          <Text style={styles.endedSub}>📍 {property?.village}</Text>
          <Text style={styles.endedSub}>🕐 {formatDate(timeLabel)}</Text>
        </View>
        <View style={styles.endedBadge}>
          <Text style={styles.endedBadgeText}>✓ ENDED</Text>
        </View>
      </View>
      {reviewQuestions.length > 0 && (
        <ReviewQuestions questions={reviewQuestions} bookingId={item.id} />
      )}
    </View>
  );
}

// ─── Main screen ───
export default function Bookings() {
  const insets = useSafeAreaInsets();
  const [bookings, setBookings]     = useState<any[]>([]);
  const [visits, setVisits]         = useState<any[]>([]);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [guestId, setGuestId]       = useState<string | null>(null);
  const [playingId, setPlayingId]   = useState<string | null>(null);
  const [activeTab, setActiveTab]   = useState<'paid' | 'scheduled' | 'ended'>('paid');
  const guestIdRef                  = useRef<string | null>(null);

  // ── Category tab: RENT / LAND / PROPERTIES ──
  // All three are live now. LAND mirrors PROPERTIES card treatment
  // (titleLine shows property_usage instead of bedroom_type).
  const [activeCategory, setActiveCategory] = useState<CategoryType>('RENT');

  const categoryBookings = bookings.filter(b => getItemCategory(b) === activeCategory);
  const categoryVisits   = visits.filter(v => getItemCategory(v) === activeCategory);

  const paidBookings = categoryBookings.filter(b => {
    return (
      b?.booking_type !== SCHEDULED_VISIT_TYPE &&
      !b?.booking_statuses?.some((s: any) => s.status === 'ended')
    );
  });

  // Visits still awaiting broker start / client end+pay
  const activeVisits = categoryVisits.filter(v => v?.status !== 'ended');
  // Visits the client has already ended + paid for — move to the Ended tab
  const endedVisits = categoryVisits.filter(v => v?.status === 'ended');

  const scheduledBookings = [
    ...categoryBookings.filter(b => b?.booking_type === SCHEDULED_VISIT_TYPE),
    ...activeVisits,
  ];

  const endedPaidBookings = categoryBookings.filter(b => {
    return (
      b?.booking_type !== SCHEDULED_VISIT_TYPE &&
      b?.booking_statuses?.some((s: any) => s.status === 'ended')
    );
  });

  const endedBookings = [...endedPaidBookings, ...endedVisits];

  const firstBookedAt = paidBookings.length > 0 ? paidBookings[0].booked_at : null;

  const fetchBookings = useCallback(async () => {
    const id = guestIdRef.current;
    if (!id) return;

    try {
      console.log('FETCHING BOOKINGS FOR:', id);

      const [bookingsRes, visitsRes] = await Promise.all([
        fetch(`${API_URL}/api/bookings/guest/${id}`),
        fetch(`${API_URL}/api/visits/guest/${id}`),
      ]);

      const bookingsData = await bookingsRes.json();
      const visitsData = await visitsRes.json();

      setBookings(Array.isArray(bookingsData) ? bookingsData : []);
      setVisits(Array.isArray(visitsData) ? visitsData : []);
    } catch (err) {
      console.log('BOOKINGS FETCH ERROR:', err);
      setBookings([]);
      setVisits([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      const id = await AsyncStorage.getItem(GUEST_KEY);
      if (id) {
        setGuestId(id);
        guestIdRef.current = id;
        await fetchBookings();
      } else {
        setLoading(false);
      }
    })();
  }, [fetchBookings]);

  useEffect(() => {
    const unsubscribeForeground = messaging().onMessage(async (remoteMessage) => {
      const type = remoteMessage.data?.type;
      if (type === 'meeting_ended') {
        Alert.alert(
          '🏁 Meeting Ended',
          'Your broker has ended the meeting. Please review your experience! 🙏',
          [{ text: 'OK', onPress: () => { fetchBookings(); setActiveTab('ended'); } }]
        );
      }
      if (type === 'new_booking') {
        Alert.alert('✅ Booking Confirmed!', 'Your booking has been confirmed.');
        fetchBookings();
      }
    });

    const unsubscribeBackground = messaging().onNotificationOpenedApp((remoteMessage) => {
      const type = remoteMessage.data?.type;
      if (type === 'meeting_ended') {
        fetchBookings();
        setActiveTab('ended');
      }
      if (type === 'new_booking') fetchBookings();
    });

    return () => {
      unsubscribeForeground();
      unsubscribeBackground();
    };
  }, [fetchBookings]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchBookings();
  }, [fetchBookings]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#D4AF37" />
        <Text style={styles.loadingText}>Loading your bookings…</Text>
      </View>
    );
  }

  const totalItemsCount = categoryBookings.length + categoryVisits.length;

  // Unique key across the merged bookings+visits Scheduled/Ended lists,
  // since a booking and a visit could otherwise share the same numeric id.
  const scheduledKeyExtractor = (item: any, index: number) => {
    const isVisit = item?.preferred_date !== undefined;
    return item?.id != null ? `${isVisit ? 'visit' : 'booking'}-${item.id}` : index.toString();
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>

      {/* ── Category tab bar: RENT / LAND / PROPERTIES ── */}
      <View style={styles.categoryTabBar}>
        {(['RENT', 'LAND', 'PROPERTIES'] as CategoryType[]).map((cat) => (
          <TouchableOpacity
            key={cat}
            style={[styles.categoryTab, activeCategory === cat && styles.categoryTabActive]}
            onPress={() => setActiveCategory(cat)}
          >
            <Text style={[styles.categoryTabText, activeCategory === cat && styles.categoryTabTextActive]}>
              {cat}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* ── RENT, LAND and PROPERTIES all share the same tab structure now.
           Data is pre-filtered above (categoryBookings/categoryVisits) via
           getItemCategory(), so everything below only sees the active
           category's items. LAND uses the same cards as PROPERTIES, just
           with property_usage instead of bedroom_type in the title line
           (handled by the shared titleLine() helper above). ── */}
      <View style={styles.topBar}>
        <View style={styles.topLeft}>
          <Text style={styles.title}>My Bookings</Text>
          {totalItemsCount > 0 && (
            <View style={styles.countBadge}>
              <Text style={styles.countText}>{totalItemsCount}</Text>
            </View>
          )}
        </View>
        {firstBookedAt && activeTab === 'paid' && (
          <CountdownClock bookedAt={firstBookedAt} />
        )}
      </View>

      {/* ── Tab buttons ── */}
      <View style={styles.tabRow}>
        <TouchableOpacity
          style={[styles.tabBtn, activeTab === 'paid' && styles.tabBtnActive]}
          onPress={() => setActiveTab('paid')}
        >
          <Text style={[styles.tabBtnText, activeTab === 'paid' && styles.tabBtnTextActive]}>
            💳 Paid
          </Text>
          {paidBookings.length > 0 && (
            <View style={styles.tabCount}>
              <Text style={styles.tabCountText}>{paidBookings.length}</Text>
            </View>
          )}
          {activeTab === 'paid' && <View style={styles.tabUnderline} />}
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.tabBtn, activeTab === 'scheduled' && styles.tabBtnActive]}
          onPress={() => setActiveTab('scheduled')}
        >
          <Text style={[styles.tabBtnText, activeTab === 'scheduled' && styles.tabBtnTextActive]}>
            📅 Scheduled
          </Text>
          {scheduledBookings.length > 0 && (
            <View style={[styles.tabCount, { backgroundColor: '#D4AF37' }]}>
              <Text style={styles.tabCountText}>{scheduledBookings.length}</Text>
            </View>
          )}
          {activeTab === 'scheduled' && <View style={styles.tabUnderline} />}
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.tabBtn, activeTab === 'ended' && styles.tabBtnActive]}
          onPress={() => setActiveTab('ended')}
        >
          <Text style={[styles.tabBtnText, activeTab === 'ended' && styles.tabBtnTextActive]}>
            ✓ Ended
          </Text>
          {endedBookings.length > 0 && (
            <View style={[styles.tabCount, { backgroundColor: '#4CAF50' }]}>
              <Text style={styles.tabCountText}>{endedBookings.length}</Text>
            </View>
          )}
          {activeTab === 'ended' && <View style={styles.tabUnderline} />}
        </TouchableOpacity>
      </View>

      {/* ── Paid tab content ── */}
      {activeTab === 'paid' && (
        paidBookings.length === 0 ? (
          <ScrollView
            contentContainerStyle={styles.emptyScrollContent}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#D4AF37" colors={['#D4AF37']} />
            }
          >
            <Text style={styles.emptyEmoji}>📋</Text>
            <Text style={styles.emptyTitle}>No bookings</Text>
            <Text style={styles.emptyText}>Your inspections will appear here</Text>
            <Text style={styles.pullHint}>Pull down anywhere here to refresh</Text>
          </ScrollView>
        ) : (
          <FlatList
            data={paidBookings}
            keyExtractor={(item, index) => item?.id?.toString() || index.toString()}
            renderItem={({ item }) => (
              <ActiveBookingCard
                item={item}
                playingId={playingId}
                setPlayingId={setPlayingId}
                guestId={guestId}
                fetchBookings={fetchBookings}
                category={activeCategory}
              />
            )}
            contentContainerStyle={{ padding: 16, paddingBottom: 40, flexGrow: 1 }}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#D4AF37" colors={['#D4AF37']} />
            }
          />
        )
      )}

      {/* ── Scheduled tab content (pay-after visits only — booking_type
           scheduled_visit items from `bookings` are legacy and typically
           empty, but kept for backward compatibility) ── */}
      {activeTab === 'scheduled' && (
        scheduledBookings.length === 0 ? (
          <ScrollView
            contentContainerStyle={styles.emptyScrollContent}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#D4AF37" colors={['#D4AF37']} />
            }
          >
            <Text style={styles.emptyEmoji}>📋</Text>
            <Text style={styles.emptyTitle}>No bookings</Text>
            <Text style={styles.emptyText}>Your inspections will appear here</Text>
            <Text style={styles.pullHint}>Pull down anywhere here to refresh</Text>
          </ScrollView>
        ) : (
          <FlatList
            data={scheduledBookings}
            keyExtractor={scheduledKeyExtractor}
            renderItem={({ item }) => (
              <ScheduledVisitCard
                item={item}
                category={activeCategory}
                guestId={guestId}
                fetchBookings={fetchBookings}
              />
            )}
            contentContainerStyle={{ padding: 16, paddingBottom: 40, flexGrow: 1 }}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#D4AF37" colors={['#D4AF37']} />
            }
          />
        )
      )}

      {/* ── Ended tab content — ended paid bookings + ended (paid) visits merged ── */}
      {activeTab === 'ended' && (
        endedBookings.length === 0 ? (
          <ScrollView
            contentContainerStyle={styles.emptyScrollContent}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#D4AF37" colors={['#D4AF37']} />
            }
          >
            <Text style={styles.emptyEmoji}>🏁</Text>
            <Text style={styles.emptyTitle}>No ended bookings</Text>
            <Text style={styles.emptyText}>Completed inspections will appear here</Text>
            <Text style={styles.pullHint}>Pull down anywhere here to refresh</Text>
          </ScrollView>
        ) : (
          <FlatList
            data={endedBookings}
            keyExtractor={scheduledKeyExtractor}
            renderItem={({ item }) => <EndedBookingCard item={item} category={activeCategory} />}
            contentContainerStyle={{ padding: 16, paddingBottom: 40, flexGrow: 1 }}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#D4AF37" colors={['#D4AF37']} />
            }
          />
        )
      )}
    </View>
  );
}

// ─── Styles Block ───
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f0f0f' },

  // ── Category tab bar (RENT / LAND / PROPERTIES) ──
  categoryTabBar: {
    flexDirection: 'row',
    backgroundColor: '#111',
    borderBottomWidth: 1,
    borderBottomColor: '#1e1e1e',
  },
  categoryTab: {
    flex: 1,
    paddingVertical: 16,
    alignItems: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  categoryTabActive:     { borderBottomColor: '#D4AF37' },
  categoryTabText:       { fontSize: 13, fontWeight: '700', color: '#555', letterSpacing: 0.5 },
  categoryTabTextActive: { color: '#D4AF37' },

  topBar: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#1f1f1f'
  },
  topLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 22, fontWeight: '900', color: '#fff', letterSpacing: 0.5 },
  countBadge: { backgroundColor: '#D4AF37', borderRadius: 12, paddingHorizontal: 8, paddingVertical: 2 },
  countText: { color: '#000', fontSize: 11, fontWeight: '800' },
  tabRow: { flexDirection: 'row', backgroundColor: '#141414', paddingVertical: 4 },
  tabBtn: { flex: 1, alignItems: 'center', paddingVertical: 12, position: 'relative', flexDirection: 'row', justifyContent: 'center', gap: 6 },
  tabBtnActive: {},
  tabBtnText: { color: '#777', fontSize: 13, fontWeight: '700' },
  tabBtnTextActive: { color: '#D4AF37' },
  tabUnderline: { position: 'absolute', bottom: 0, left: '15%', right: '15%', height: 3, backgroundColor: '#D4AF37', borderRadius: 2 },
  tabCount: { backgroundColor: '#777', borderRadius: 10, paddingHorizontal: 6, paddingVertical: 1 },
  tabCountText: { color: '#000', fontSize: 10, fontWeight: '800' },
  card: { backgroundColor: '#141414', borderRadius: 16, marginBottom: 16, overflow: 'hidden', borderWidth: 1, borderColor: '#1f1f1f' },
  cardEnded: { borderColor: 'rgba(80,80,80,0.2)' },
  thumbnail: { width: '100%', height: 200 },
  playOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.3)', justifyContent: 'center', alignItems: 'center' },
  playBtn: { width: 56, height: 56, borderRadius: 28, backgroundColor: 'rgba(214,175,55,0.9)', justifyContent: 'center', alignItems: 'center', elevation: 4 },
  playIcon: { color: '#000', fontSize: 20, marginLeft: 4, fontWeight: 'bold' },
  thumbnailPlaceholder: { width: '100%', height: 140, backgroundColor: '#1f1f1f', justifyContent: 'center', alignItems: 'center' },
  thumbnailPlaceholderText: { fontSize: 36 },
  video: { width: '100%', height: 220, backgroundColor: '#000' },
  details: { padding: 16 },
  propertyType: { fontSize: 15, fontWeight: '800', color: '#D4AF37', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  detail: { fontSize: 13, color: '#aaa', marginBottom: 5, fontWeight: '500' },
  divider: { height: 1, backgroundColor: '#222', marginVertical: 12 },
  sectionLabel: { fontSize: 11, fontWeight: '800', color: '#666', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 },
  missingDataNotice: { fontSize: 12, color: '#FFB300', fontStyle: 'italic', marginBottom: 4 },
  statusBadge: { fontSize: 11, fontWeight: '800', borderRadius: 4, overflow: 'hidden' },
  statusPending: { backgroundColor: 'rgba(212,175,55,0.15)', color: '#D4AF37' },
  statusStarted: { backgroundColor: 'rgba(76,175,80,0.15)', color: '#4CAF50' },
  clockRow: { marginTop: 12, padding: 12, backgroundColor: '#1a1a1a', borderRadius: 12, borderWidth: 1, borderColor: '#222', gap: 8 },
  clockHint: { fontSize: 9, fontWeight: '800', color: '#777', letterSpacing: 0.5, textAlign: 'center' },
  actions: { paddingHorizontal: 16, paddingBottom: 16, gap: 10 },
  callBtn: { backgroundColor: '#1f1f1f', paddingVertical: 12, borderRadius: 12, alignItems: 'center', borderWidth: 1, borderColor: '#333' },
  callBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  visitHint: { fontSize: 11, color: '#777', textAlign: 'center', lineHeight: 16, paddingHorizontal: 8 },
  startVisitBtn: { backgroundColor: '#D4AF37', paddingVertical: 14, borderRadius: 12, alignItems: 'center', elevation: 2 },
  startVisitText: { color: '#000', fontSize: 14, fontWeight: '900', letterSpacing: 0.5 },
  endMeetingBtn: { backgroundColor: 'rgba(229,57,53,0.12)', borderWidth: 1.5, borderColor: '#E53935', paddingVertical: 14, borderRadius: 12, alignItems: 'center', marginTop: 4 },
  endMeetingBtnText: { color: '#E53935', fontSize: 14, fontWeight: '900', letterSpacing: 0.5 },
  verifyBtn: { backgroundColor: '#16a34a', paddingVertical: 14, borderRadius: 12, alignItems: 'center', marginTop: 4 },
  verifyBtnText: { color: '#fff', fontSize: 14, fontWeight: '900', letterSpacing: 0.5 },
  endedHeader: { padding: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', backgroundColor: '#181818' },
  endedTitle: { fontSize: 14, fontWeight: '700', color: '#888' },
  endedSub: { fontSize: 12, color: '#555', marginTop: 3 },
  endedBadge: { backgroundColor: 'rgba(80,80,80,0.15)', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, borderWidth: 0.5, borderColor: '#333' },
  endedBadgeText: { color: '#666', fontSize: 10, fontWeight: '800' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  emptyScrollContent: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  pullHint: { fontSize: 11, color: '#444', textAlign: 'center', marginTop: 14, fontStyle: 'italic' },
  loadingText: { marginTop: 12, color: '#777', fontSize: 13, fontWeight: '500' },
  emptyEmoji: { fontSize: 40, marginBottom: 12 },
  emptyTitle: { fontSize: 16, fontWeight: '800', color: '#fff', marginBottom: 4 },
  emptyText: { fontSize: 12, color: '#555', textAlign: 'center' },
});
