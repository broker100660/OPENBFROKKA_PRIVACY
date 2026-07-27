import { Tabs } from 'expo-router';
import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_URL } from '../../config/api';

const GUEST_KEY = 'guest_id';

// ─── Review Modal (unchanged logic) ───
function ReviewModal() {
  return null; // keep your existing implementation here unchanged
}

// ─── Custom Tab Bar ───
function MyTabBar({ navigation, state }: any) {
  const insets = useSafeAreaInsets();

  const tabs = [
    { label: '🏠', text: 'Home', route: 'index' },
    { label: '📋', text: 'Bookings', route: 'bookings' },
  ];

  return (
    <View style={[styles.bar, { paddingBottom: insets.bottom + 8 }]}>
      {tabs.map((tab) => {
        const isActive = state.routes[state.index].name === tab.route;

        return (
          <TouchableOpacity
            key={tab.route}
            style={styles.tab}
            onPress={() => navigation.navigate(tab.route)}
          >
            <Text style={styles.icon}>{tab.label}</Text>
            <Text style={[styles.label, isActive && styles.activeLabel]}>
              {tab.text}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

// ─── Layout ───
export default function Layout() {
  return (
    <Tabs
      tabBar={(props) => <MyTabBar {...props} />}
      screenOptions={{
        headerShown: false,
      }}
    >
      <Tabs.Screen name="index" />
      <Tabs.Screen name="bookings" />
      <Tabs.Screen name="explore" />
    </Tabs>
  );
}

// ─── Styles ───
const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingVertical: 12,
    backgroundColor: '#000',

    borderTopWidth: 1,
    borderColor: '#1a1a1a',
  },

  tab: {
    alignItems: 'center',
    flex: 1,
    gap: 4,
  },

  icon: {
    fontSize: 26,
  },

  label: {
    fontSize: 12,
    color: '#555',
    fontWeight: '700',
    textTransform: 'uppercase',
  },

  activeLabel: {
    color: '#D4AF37',
    fontWeight: '900',
  },
});