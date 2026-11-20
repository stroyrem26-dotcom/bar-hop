"use strict";

const telegram = window.Telegram?.WebApp;
if (telegram?.initData) {
  telegram.ready();
  telegram.expand();
  telegram.setHeaderColor?.("#080808");
  telegram.setBackgroundColor?.("#080808");
}

const byId = (id) => document.getElementById(id);
const catalog = {
  bars: [],
  category: "",
  okrug: "",
  view: "catalog",
  selected: null,
  favorites: new Set(),
};
const mapState = { map: null, layer: null, route: null, start: null, pending: null, picking: false, lastRequest: 0 };
const mobile = matchMedia("(max-width: 760px)");
const storageKey = "bar-hop-wsh-favorites-v1";

try {
  const saved = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
  if (Array.isArray(saved)) catalog.favorites = new Set(saved.filter((id) => typeof id === "string"));
} catch {
  // Browser storage is optional in Telegram's in-app browser.
}

function normalize(value) {
  return value.toLocaleLowerCase("ru").replaceAll("ё", "е").trim();
}

const districtsByOkrug = {
  "ЦАО": "Арбат|Басманный|Замоскворечье|Красносельский|Мещанский|Пресненский|Таганский|Тверской|Хамовники|Якиманка",
  "САО": "Аэропорт|Беговой|Бескудниковский|Войковский|Восточное Дегунино|Головинский|Дмитровский|Западное Дегунино|Коптево|Левобережный|Молжаниновский|Савёловский|Сокол|Тимирязевский|Ховрино|Хорошёвский",
  "СВАО": "Алексеевский|Алтуфьевский|Бабушкинский|Бибирево|Бутырский|Лианозово|Лосиноостровский|Марфино|Марьина Роща|Останкинский|Отрадное|Ростокино|Свиблово|Северный|Северное Медведково|Южное Медведково|Ярославский",
  "ВАО": "Богородское|Вешняки|Восточный|Восточное Измайлово|Гольяново|Ивановское|Измайлово|Косино-Ухтомский|Метрогородок|Новогиреево|Новокосино|Перово|Преображенское|Северное Измайлово|Соколиная Гора|Сокольники",
  "ЮВАО": "Выхино-Жулебино|Капотня|Кузьминки|Лефортово|Люблино|Марьино|Некрасовка|Нижегородский|Печатники|Рязанский|Текстильщики|Южнопортовый",
  "ЮАО": "Бирюлёво Восточное|Бирюлёво Западное|Братеево|Даниловский|Донской|Зябликово|Москворечье-Сабурово|Нагатинский Затон|Нагатино-Садовники|Нагорный|Орехово-Борисово Северное|Орехово-Борисово Южное|Царицыно|Чертаново Северное|Чертаново Центральное|Чертаново Южное",
  "ЮЗАО": "Академический|Гагаринский|Зюзино|Коньково|Котловка|Ломоносовский|Обручевский|Северное Бутово|Тёплый Стан|Черёмушки|Южное Бутово|Ясенево",
  "ЗАО": "Внуково|Дорогомилово|Крылатское|Кунцево|Можайский|Ново-Переделкино|Очаково-Матвеевское|Проспект Вернадского|Раменки|Солнцево|Тропарёво-Никулино|Филёвский Парк|Фили-Давыдково",
  "СЗАО": "Куркино|Митино|Покровское-Стрешнево|Северное Тушино|Строгино|Хорошёво-Мнёвники|Щукино|Южное Тушино",
  "ЗелАО": "Крюково|Матушкино|Савёлки|Силино|Старое Крюково|Зеленоград",
  "НАО": "Коммунарка|Филимонковский|Внуковское|Воскресенское|Десёновское|Кокошкино|Марушкинское|Московский|Мосрентген|Рязановское|Сосенское",
  "ТАО": "Троицк|Краснопахорский|Вороново|Щербинка|Бекасово",
};

const okrugByDistrict = new Map(Object.entries(districtsByOkrug).flatMap(([okrug, districts]) =>
  [okrug, ...districts.split("|")].map((district) => [normalize(district), okrug]),
));

function barOkrug(bar) {
  return okrugByDistrict.get(normalize(bar.district).replace(/^район\s+/, ""));
}

function validBar(bar) {
  return bar && ["id", "name", "address", "district", "summary"].every((key) => typeof bar[key] === "string" && bar[key].trim())
    && Array.isArray(bar.categories) && bar.categories.length > 0
    && bar.categories.every((tag) => typeof tag === "string" && tag.trim())
    && Number.isFinite(bar.lat) && bar.lat >= 55.4 && bar.lat <= 56
    && Number.isFinite(bar.lon) && bar.lon >= 37.1 && bar.lon <= 38
    && /^https:\/\/t\.me\/HoppingBar\/[1-9]\d*$/i.test(bar.post);
}

async function fetchJson(url, timeout = 7000) {
  return request(url, (response) => response.json(), timeout);
}

async function request(url, decode, timeout) {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal, credentials: "omit" });
    if (!response.ok) throw new Error("HTTP " + response.status);
    return await decode(response);
  } finally {
    clearTimeout(deadline);
  }
}

function decodeCsv(input) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === '"') {
      if (quoted && input[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && char === ",") {
      row.push(cell);
      cell = "";
    } else if (!quoted && (char === "\n" || char === "\r")) {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      if (char === "\r" && input[index + 1] === "\n") index += 1;
    } else {
      cell += char;
    }
  }
  if (quoted) throw new Error("Corrupt CSV");
  if (row.length || cell) rows.push([...row, cell]);
  const columns = rows.shift();
  if (columns?.join(",") !== "id,name,district,address,categories,summary,lat,lon,post,source,telepub_id,active") {
    throw new Error("Unexpected catalog columns");
  }
  return rows.filter((record) => record[11]?.toUpperCase() === "TRUE").map((record) => {
    const [id, name, district, address, tags, summary, lat, lon, post] = record;
    return { id, name, district, address, categories: tags.split(",").map((value) => value.trim()).filter(Boolean),
      summary, lat: Number(lat.replace(",", ".")), lon: Number(lon.replace(",", ".")), post };
  });
}

async function loadCatalog() {
  const current = await fetchJson("./catalog.json");
  const bars = current.bars;
  if (!Array.isArray(bars)) throw new Error("Invalid catalog");
  let live;
  if (typeof current.feed === "string" && current.feed.startsWith("https://docs.google.com/spreadsheets/d/e/")) {
    try {
      const url = new URL(current.feed);
      if (url.searchParams.get("output") === "csv" && url.searchParams.get("gid")) {
        live = decodeCsv((await request(url.href, (response) => response.text(), 4500)).replace(/^\uFEFF/, ""));
        document.documentElement.dataset.catalogSource = "sheets";
      }
    } catch {
      // The last confirmed public export is available if the feed is offline.
    }
  } else if (typeof current.feed === "string" && current.feed.startsWith("https://script.google.com/macros/s/")) {
    try {
      const remote = await fetchJson(current.feed, 4500);
      if (Array.isArray(remote.bars)) live = remote.bars;
    } catch {
      // The last confirmed public export is available if the feed is offline.
    }
  }
  catalog.bars = [...new Map((live ?? bars).filter(validBar).map((bar) => [bar.id, bar])).values()];
}

function visibleBars() {
  return catalog.bars.filter((bar) =>
    (!catalog.okrug || barOkrug(bar) === catalog.okrug)
    && (!catalog.category || bar.categories.includes(catalog.category))
    && (catalog.view !== "favorites" || catalog.favorites.has(bar.id)),
  );
}

function createChip(label, value) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "chip";
  button.textContent = label;
  button.dataset.category = value;
  button.setAttribute("aria-pressed", String(value === catalog.category));
  return button;
}

function renderFilters() {
  const tags = [...new Set(catalog.bars.flatMap((bar) => bar.categories))]
    .sort((left, right) => left.localeCompare(right, "ru"));
  byId("categories").replaceChildren(createChip("Все", ""), ...tags.map((tag) => createChip(tag, tag)));
}

function setFavorite(id, button) {
  const add = !catalog.favorites.has(id);
  if (add) catalog.favorites.add(id);
  else catalog.favorites.delete(id);
  try { localStorage.setItem(storageKey, JSON.stringify([...catalog.favorites])); } catch {}
  if (catalog.view === "favorites" && !add) {
    renderCards();
    document.querySelector('[data-tab="favorites"]').focus();
    return;
  }
  button.setAttribute("aria-pressed", String(add));
  button.textContent = add ? "♥" : "♡";
  button.setAttribute("aria-label", add ? "Убрать из избранного" : "Добавить в избранное");
}

function createCard(bar) {
  const card = byId("card-template").content.firstElementChild.cloneNode(true);
  card.dataset.id = bar.id;
  card.toggleAttribute("data-selected", catalog.selected?.id === bar.id);
  const query = (selector) => card.querySelector(selector);
  query(".name").textContent = bar.name;
  query(".address").textContent = bar.address + " · " + bar.district;
  query(".summary").textContent = bar.summary;
  query(".read").href = bar.post;
  query(".locate").addEventListener("click", () => selectBar(bar, true));
  query(".tags").replaceChildren(...bar.categories.slice(0, 2).map((tag) => {
    const label = document.createElement("span");
    label.textContent = tag;
    return label;
  }));
  const favorite = query(".heart");
  const selected = catalog.favorites.has(bar.id);
  favorite.textContent = selected ? "♥" : "♡";
  favorite.setAttribute("aria-pressed", String(selected));
  favorite.setAttribute("aria-label", selected ? "Убрать из избранного" : "Добавить в избранное");
  favorite.addEventListener("click", () => setFavorite(bar.id, favorite));
  return card;
}

function renderCards() {
  const bars = visibleBars();
  byId("list-title").textContent = catalog.view === "favorites" ? "Избранное" : "Места на вечер";
  const form = new Intl.PluralRules("ru").select(bars.length);
  byId("count").textContent = bars.length + " " + ({ one: "место", few: "места", many: "мест" }[form] ?? "места");
  byId("cards").replaceChildren(...bars.map(createCard));
  byId("empty").hidden = bars.length !== 0;
  byId("empty").textContent = catalog.view === "favorites" && !catalog.favorites.size
    ? "Нажмите на сердце в карточке, чтобы сохранить бар." : "Подходящих баров пока нет. Выберите другой округ или категорию.";
}

function switchView(view, scroll = false) {
  catalog.view = view;
  document.body.dataset.view = view;
  document.querySelectorAll("[data-tab]").forEach((tab) =>
    tab.setAttribute("aria-pressed", String(tab.dataset.tab === view)));
  renderCards();
  if (view === "map") {
    ensureMap();
    requestAnimationFrame(() => {
      mapState.map?.invalidateSize();
      if (catalog.selected) mapState.map?.panTo([catalog.selected.lat, catalog.selected.lon]);
      else fitMap();
    });
  }
  if (scroll && mobile.matches) window.scrollTo({ top: 0, behavior: "instant" });
}

function ensureMap() {
  if (mapState.map || !window.L) return;
  mapState.map = L.map("map").setView([55.7558, 37.6176], 12);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> · <a href="https://www.openstreetmap.org/fixthemap" target="_blank">Исправить карту</a>',
  }).addTo(mapState.map);
  mapState.layer = L.layerGroup().addTo(mapState.map);
  mapState.map.on("click", ({ latlng }) => {
    if (!mapState.picking || !catalog.selected) return;
    setPicking(false);
    void routeFrom([latlng.lat, latlng.lng]);
  });
  renderPins();
  fitMap();
}

function fitMap() {
  if (mapState.map && catalog.bars.length) mapState.map.fitBounds(
    catalog.bars.map((bar) => [bar.lat, bar.lon]), { padding: [24, 24], maxZoom: 15 },
  );
}

function renderPins() {
  if (!mapState.layer) return;
  mapState.layer.clearLayers();
  const bars = catalog.bars;
  const overlaps = new Map();
  for (const bar of bars) {
    const key = [bar.lat.toFixed(5), bar.lon.toFixed(5)].join(",");
    const group = overlaps.get(key) ?? [];
    group.push(bar);
    overlaps.set(key, group);
  }
  for (const group of overlaps.values()) {
    for (const [index, bar] of group.entries()) {
      const selected = catalog.selected?.id === bar.id;
      const offset = group.length > 1 ? (index - (group.length - 1) / 2) * .00023 : 0;
      const icon = L.divIcon({
        className: "map-pin" + (selected ? " is-active" : ""),
        html: '<span aria-hidden="true">◆</span>', iconSize: [27, 27],
      });
      const tooltip = document.createElement("span");
      tooltip.textContent = bar.name;
      L.marker([bar.lat, bar.lon + offset], { title: bar.name, icon, zIndexOffset: selected ? 100 : 0 })
        .bindTooltip(tooltip).on("click", () => selectBar(bar, false)).addTo(mapState.layer);
    }
  }
}

function setPicking(picking) {
  mapState.picking = picking;
  byId("pick-origin").setAttribute("aria-pressed", String(picking));
  byId("map").style.cursor = picking ? "crosshair" : "";
}

function clearRoute() {
  mapState.pending?.abort();
  mapState.pending = null;
  mapState.route?.remove();
  mapState.start?.remove();
  mapState.route = null;
  mapState.start = null;
}

function setRouteStatus(text) {
  byId("route-status").textContent = text;
}

function externalRoute(bar, start = null) {
  const url = new URL("https://yandex.ru/maps/");
  url.searchParams.set("rtext", (start ? start.join(",") : "") + "~" + [bar.lat, bar.lon].join(","));
  url.searchParams.set("rtt", "pd");
  return url.toString();
}

function selectBar(bar, openMap) {
  if (catalog.selected?.id !== bar.id) clearRoute();
  catalog.selected = bar;
  if (openMap && mobile.matches) switchView("map", true);
  else ensureMap();
  renderPins();
  document.querySelectorAll(".card").forEach((card) =>
    card.toggleAttribute("data-selected", card.dataset.id === bar.id));
  mapState.map?.setView([bar.lat, bar.lon], Math.max(15, mapState.map.getZoom()));
  setPicking(false);
  byId("destination").textContent = bar.name;
  byId("route-actions").hidden = false;
  byId("location-note").hidden = false;
  byId("external-map").href = externalRoute(bar);
  byId("pick-origin").disabled = !mapState.map;
  byId("use-location").disabled = !mapState.map;
  if (mapState.route) return;
  setRouteStatus(mapState.map ? bar.address : bar.address + " · Встроенная карта недоступна, откройте Яндекс Карты.");
}

async function routeFrom(start) {
  const bar = catalog.selected;
  if (!bar || !mapState.map) return;
  if (start[0] < 55.3 || start[0] > 56.1 || start[1] < 37 || start[1] > 38.2) {
    setRouteStatus("Выберите начальную точку в Москве.");
    return;
  }
  if (Date.now() - mapState.lastRequest < 1200) {
    setRouteStatus("Подождите секунду и повторите.");
    return;
  }
  clearRoute();
  const controller = new AbortController();
  mapState.pending = controller;
  mapState.lastRequest = Date.now();
  byId("external-map").href = externalRoute(bar, start);
  setRouteStatus("Строим маршрут…");
  const coordinates = [start, [bar.lat, bar.lon]].map(([lat, lon]) => lon.toFixed(6) + "," + lat.toFixed(6)).join(";");
  const timeout = setTimeout(() => controller.abort(), 9000);
  try {
    const res = await fetch("https://routing.openstreetmap.de/routed-foot/route/v1/driving/" + coordinates + "?overview=full&geometries=geojson&steps=false", {
      signal: controller.signal, credentials: "omit",
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const result = (await res.json()).routes?.[0];
    if (mapState.pending !== controller || catalog.selected?.id !== bar.id) return;
    if (!result || !Array.isArray(result.geometry?.coordinates) || result.geometry.coordinates.length < 2) throw new Error("No route");
    mapState.route = L.geoJSON(result.geometry, { style: { color: "#bc6d13", weight: 6, opacity: .92 } }).addTo(mapState.map);
    mapState.start = L.circleMarker(start, { color: "#16130d", weight: 2, fillColor: "#ffe0a0", fillOpacity: 1, radius: 6 })
      .addTo(mapState.map).bindTooltip("Старт");
    mapState.map.fitBounds(mapState.route.getBounds().extend(start), { padding: [27, 27], maxZoom: 17 });
    const minutes = Math.max(1, Math.round(result.duration / 60));
    const distance = result.distance < 1000 ? Math.round(result.distance) + " м"
      : new Intl.NumberFormat("ru", { maximumFractionDigits: 1 }).format(result.distance / 1000) + " км";
    setRouteStatus(distance + " пешком · около " + minutes + " мин");
  } catch {
    if (mapState.pending === controller) setRouteStatus("Маршрут недоступен. Попробуйте другую точку или откройте Яндекс Карты.");
  } finally {
    clearTimeout(timeout);
    if (mapState.pending === controller) mapState.pending = null;
  }
}

byId("use-location").addEventListener("click", () => {
  if (!navigator.geolocation) {
    setRouteStatus("Геолокация недоступна. Выберите старт на карте.");
    return;
  }
  setPicking(false);
  const id = catalog.selected?.id;
  setRouteStatus("Определяем ваше местоположение…");
  navigator.geolocation.getCurrentPosition(({ coords }) => {
    if (catalog.selected?.id === id) void routeFrom([coords.latitude, coords.longitude]);
  }, () => {
    if (catalog.selected?.id === id) setRouteStatus("Не удалось получить геопозицию. Выберите старт на карте.");
  }, { enableHighAccuracy: false, timeout: 8000, maximumAge: 20000 });
});

byId("pick-origin").addEventListener("click", () => {
  setPicking(!mapState.picking);
  setRouteStatus(mapState.picking ? "Коснитесь карты в точке, откуда пойдёте." : catalog.selected.address);
});
byId("show-all").addEventListener("click", () => {
  clearRoute();
  catalog.selected = null;
  setPicking(false);
  renderCards();
  renderPins();
  fitMap();
  byId("destination").textContent = "Выберите бар";
  byId("route-actions").hidden = true;
  byId("location-note").hidden = true;
  setRouteStatus("Нажмите на точку или кнопку «На карте» в карточке.");
});
byId("okrug").replaceChildren(
  new Option("Все округа", ""),
  ...Object.keys(districtsByOkrug).map((okrug) => new Option(okrug, okrug)),
);
byId("okrug").addEventListener("change", (event) => {
  catalog.okrug = event.target.value;
  renderCards();
});
byId("categories").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-category]");
  if (!button) return;
  catalog.category = button.dataset.category;
  byId("categories").querySelectorAll("button").forEach((chip) =>
    chip.setAttribute("aria-pressed", String(chip === button)));
  renderCards();
});
document.querySelector(".tabs").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-tab]");
  if (tab) switchView(tab.dataset.tab, true);
});
document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-telegram]");
  if (!link || !telegram?.initData || !telegram.openTelegramLink) return;
  event.preventDefault();
  telegram.openTelegramLink(link.href);
});
mobile.addEventListener("change", () => {
  if (!mobile.matches || catalog.view === "map") {
    ensureMap();
    mapState.map?.invalidateSize();
  }
});

loadCatalog().then(() => {
  renderFilters();
  switchView("catalog");
  if (!mobile.matches) ensureMap();
  if (!window.L) setRouteStatus("Не удалось загрузить карту. Откройте Яндекс Карты из карточки бара.");
}).catch(() => {
  byId("empty").hidden = false;
  byId("empty").textContent = "Не удалось загрузить каталог. Откройте канал или обновите страницу.";
});
