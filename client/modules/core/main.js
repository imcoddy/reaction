import _ from "lodash";
import store from "store";
import { Accounts as MeteorAccounts } from "meteor/accounts-base";
import { Meteor } from "meteor/meteor";
import { Session } from "meteor/session";
import { check } from "meteor/check";
import { Tracker } from "meteor/tracker";
import { ReactiveVar } from "meteor/reactive-var";
import { ReactiveDict } from "meteor/reactive-dict";
import { Roles } from "meteor/alanning:roles";
import Logger from "/client/modules/logger";
import { Countries } from "/client/collections";
import { localeDep } from "/client/modules/i18n";
import { Packages, Shops } from "/lib/collections";
import { Router } from "/client/modules/router";
import { DomainsMixin } from "./domains";
import { getUserId } from "./helpers/utils";

/**
 * Reaction core namespace for client code
 * @namespace Core/Client
 */

// Global, private state object for client side
// This is placed outside the main object to make it a private variable.
// access using `Reaction.state`
const reactionState = new ReactiveDict();

export const userPrefs = new ReactiveVar(undefined, (val, newVal) => JSON.stringify(val) === JSON.stringify(newVal));

const deps = new Map();

// Slugify is imported when Reaction.getSlug is called
let slugify;

// Array of ISO Language codes for all languages that use latin based char sets
// list is based on this matrix http://w3c.github.io/typography/gap-analysis/language-matrix.html
// list of lang codes https://en.wikipedia.org/wiki/List_of_ISO_639-1_codes
const latinLangs = ["az", "da", "de", "en", "es", "ff", "fr", "ha", "hr", "hu", "ig", "is", "it", "jv", "ku", "ms", "nl", "no", "om", "pl", "pt", "ro", "sv", "sw", "tl", "tr", "uz", "vi", "yo"]; // eslint-disable-line max-len

export default {
  ...DomainsMixin,

  /**
   * @summary The active shop
   * @memberof Core/Client
   * @private
   */
  _shopId: new ReactiveVar(null),

  /**
   * @summary The first shop created
   * @memberof Core/Client
   * @private
   */
  _primaryShopId: new ReactiveVar(null),

  /**
   * @summary Marketplace Settings
   * @memberof Core/Client
   * @private
   */
  marketplace: { _ready: false },

  /**
   * @summary Current locale
   * @memberof Core/Client
   * @type {ReactiveVar}
   */
  Locale: new ReactiveVar({}),

  /**
   * @summary Initialization code
   * @memberof Core/Client
   * @method
   * @returns {Object} An autorun computation
   */
  init() {
    Tracker.autorun(() => {
      // marketplaceSettings come over on the PrimaryShopPackages subscription
      if (this.Subscriptions.PrimaryShopPackages.ready()) {
        if (!this.marketplace._ready) {
          const marketplacePkgSettings = this.getMarketplaceSettings();
          if (marketplacePkgSettings && marketplacePkgSettings.public) {
            this.marketplace._ready = true;
            this.marketplace = marketplacePkgSettings.public;
            this.marketplace.enabled = true;
          }
        }
      }
    });

    // Listen for the primary shop subscription and set accordingly
    Tracker.autorun(() => {
      let shop;
      if (this.Subscriptions.PrimaryShop.ready()) {
        // There should only ever be one "primary" shop
        shop = Shops.findOne({
          shopType: "primary"
        });

        if (shop) {
          this._primaryShopId.set(shop._id);

          // We'll initialize locale and currency for the primary shop unless
          // marketplace settings exist and merchantLocale is set to true
          if (this.marketplace.merchantLocale !== true) {
            // initialize local client Countries collection
            if (!Countries.findOne()) {
              createCountryCollection(shop.locales.countries);
            }

            const locale = this.Locale.get() || {};

            // fix for https://github.com/reactioncommerce/reaction/issues/248
            // we need to keep an eye for rates changes
            if (typeof locale.locale === "object" &&
                 typeof locale.currency === "object" &&
                 typeof locale.locale.currency === "string") {
              const localeCurrency = locale.locale.currency.split(",")[0];
              if (typeof shop.currencies[localeCurrency] === "object") {
                if (typeof shop.currencies[localeCurrency].rate === "number") {
                  locale.currency.rate = shop.currencies[localeCurrency].rate;
                  localeDep.changed();
                }
              }
            }
            // we are looking for a shopCurrency changes here
            if (typeof locale.shopCurrency === "object") {
              locale.shopCurrency = shop.currencies[shop.currency];
              localeDep.changed();
            }
          }
        }
      }
    });

    // Listen for active shop change
    return Tracker.autorun(() => { // eslint-disable-line consistent-return
      if (this.Subscriptions.MerchantShops.ready()) {
        // if we don't have an active shopId, try to retrieve it from the userPreferences object
        // and set the shop from the storedShopId
        if (!this.shopId) {
          const shop = this.getCurrentShop();

          if (shop) {
            // Only set shopId if it hasn't been set yet
            if (!this.shopId) {
              this.shopId = shop._id;
              this.shopName = shop.name;
            }

            // We only use the active shop to setup locale if marketplace settings
            // are enabled and merchantLocale is set to true
            if (this.marketplace.merchantLocale === true) {
              // initialize local client Countries collection
              if (!Countries.findOne()) {
                createCountryCollection(shop.locales.countries);
              }

              const locale = this.Locale.get() || {};

              // fix for https://github.com/reactioncommerce/reaction/issues/248
              // we need to keep an eye for rates changes
              if (typeof locale.locale === "object" &&
              typeof locale.currency === "object" &&
              typeof locale.locale.currency === "string") {
                const localeCurrency = locale.locale.currency.split(",")[0];
                if (typeof shop.currencies[localeCurrency] === "object") {
                  if (typeof shop.currencies[localeCurrency].rate === "number") {
                    locale.currency.rate = shop.currencies[localeCurrency].rate;
                    localeDep.changed();
                  }
                }
              }
              // we are looking for a shopCurrency changes here
              if (typeof locale.shopCurrency === "object") {
                locale.shopCurrency = shop.currencies[shop.currency];
                localeDep.changed();
              }
            }
            return this;
          }
        }
      }
    });
  },

  /**
   * @summary Return global "reactionState" Reactive Dict
   * @memberof Core/Client
   */
  get state() {
    return reactionState;
  },

  /**
   * @name hasPermission
   * @summary client permissions checks. hasPermission exists on both the server and the client.
   * @method
   * @memberof Core/Client
   * @param {String | Array} checkPermissions -String or Array of permissions if empty, defaults to "admin, owner"
   * @param {String} checkUserId - userId, defaults to logged in user ID
   * @param {String} checkGroup group - default to shopId
   * @return {Boolean} Boolean - true if has permission
   */
  hasPermission(checkPermissions, checkUserId, checkGroup) {
    let group;
    // default group to the shop or global if shop isn't defined for some reason.
    if (checkGroup !== undefined && typeof checkGroup === "string") {
      group = checkGroup;
    } else {
      group = this.getShopId() || Roles.GLOBAL_GROUP;
    }

    let permissions = ["owner"];
    let id = "";
    const userId = checkUserId || getUserId();

    /**
     * @summary local roleCheck function is the bulk of the logic called out a userId is validated.
     * @private
     * @returns {Boolean} Did check pass?
     */
    function roleCheck() {
      // permissions can be either a string or an array
      // we'll force it into an array and use that
      if (checkPermissions === undefined) {
        permissions = ["owner"];
      } else if (typeof checkPermissions === "string") {
        permissions = [checkPermissions];
      } else {
        permissions = checkPermissions;
      }
      // if the user has owner permissions we'll always check if those roles are enough
      // By adding the "owner" role to the permissions list, we are making hasPermission always return
      // true for "owners". This gives owners global access.
      // TODO: Review this way of granting global access for owners
      permissions.push("owner");
      permissions = _.uniq(permissions);

      //
      // return if user has permissions in the group
      //
      if (Roles.userIsInRole(userId, permissions, group)) {
        return true;
      }

      // global roles check
      // TODO: Review this commented out code
      /*

      const sellerShopPermissions = Roles.getGroupsForUser(userId, "admin");
      // we're looking for seller permissions.
      if (sellerShopPermissions) {
        // loop through shops roles and check permissions
        for (const key in sellerShopPermissions) {
          if (key) {
            const shop = sellerShopPermissions[key];
            if (Roles.userIsInRole(userId, permissions, shop)) {
              return true;
            }
          }
        }
      }*/
      // no specific permissions found returning false
      return false;
    }

    /**
     * @summary check if a user id has been found in setTimeout
     * @returns {Boolean} Did role check pass?
     */
    function validateUserId() {
      if (getUserId()) {
        Meteor.clearTimeout(id);
        Router.reload();
        return roleCheck();
      }
      return false;
    }

    //
    // actual logic block to check permissions
    // we'll bypass unnecessary checks during
    // a user logging, as we'll check again
    // when everything is ready
    //
    let loggingIn;
    Tracker.nonreactive(() => {
      loggingIn = MeteorAccounts.loggingIn();
    });
    if (loggingIn === false) {
      //
      // this userId check happens because when logout
      // occurs it takes a few cycles for a new anonymous user
      // to get created and during this time the user has no
      // permission, not even guest permissions so we
      // need to wait and reload the routes. This
      // mainly affects the logout from dashboard pages
      //
      if (!userId) {
        id = Meteor.setTimeout(validateUserId, 5000);
      } else {
        return roleCheck();
      }
    }
    // return false to be safe
    return false;
  },


  /**
   * @name hasDashboardAccessForAnyShop
   * @summary client permission check for any "owner", "admin", or "dashboard" permissions for any shop.
   * @method
   * @memberof Core/Client
   * @todo This could be faster with a dedicated hasAdminDashboard boolean on the user object
   * @param { Object } options - options object that can be passed a user and/or a set of permissions
   * @return {Boolean} Boolean - true if has dashboard access for any shop
   */
  hasDashboardAccessForAnyShop(options = { user: Meteor.user(), permissions: ["owner", "admin", "dashboard"] }) {
    const { user, permissions } = options;

    if (!user || !user.roles) {
      return false;
    }

    // Nested find that determines if a user has any of the permissions
    // specified in the `permissions` array for any shop
    const hasPermissions = Object.keys(user.roles).find((shopId) => user.roles[shopId].find((role) => permissions.find((permission) => permission === role)));

    // Find returns undefined if nothing is found.
    // This will return true if permissions are found, false otherwise
    return typeof hasPermissions !== "undefined";
  },

  /**
   * @name hasDashboardAccessForMultipleShops
   * @method
   * @memberof Core/Client
   * @summary - client permission check for any "owner", "admin", or "dashboard" permissions for more than one shop.
   * @return {Boolean} Boolean - true if has dashboard access for more than one shop
   */
  hasDashboardAccessForMultipleShops() {
    const adminShopIds = this.getShopsForUser(["owner", "admin", "dashboard"]);
    return Array.isArray(adminShopIds) && adminShopIds.length > 1;
  },

  /**
   * @name hasOwnerAccess
   * @method
   * @memberof Core/Client
   * @returns {Boolean} Does current user have "owner" role?
   */
  hasOwnerAccess() {
    const ownerPermissions = ["owner"];
    return this.hasPermission(ownerPermissions);
  },

  /**
   * Checks to see if the user has admin permissions. If a shopId is optionally
   * passed in, we check for that shopId, otherwise we check against the default
   * @name hasAdminAccess
   * @method
   * @memberof Core/Client
   * @param  {string} [shopId] Optional shopId to check access against
   * @return {Boolean} true if the user has admin or owner permission, otherwise false
   */
  hasAdminAccess(shopId) {
    const adminPermissions = ["owner", "admin"];
    if (shopId) {
      return this.hasPermission(adminPermissions, getUserId(), shopId);
    }
    return this.hasPermission(adminPermissions);
  },

  /**
   * @name hasDashboardAccess
   * @method
   * @memberof Core/Client
   * @returns {Boolean} Does current user have access to the admin dashboard?
   */
  hasDashboardAccess() {
    const dashboardPermissions = ["owner", "admin", "dashboard"];
    return this.hasPermission(dashboardPermissions);
  },

  /**
   * @name hasShopSwitcherAccess
   * @method
   * @memberof Core/Client
   * @returns {Boolean} Does current user have access to the shop switcher component?
   */
  hasShopSwitcherAccess() {
    return this.hasDashboardAccessForMultipleShops();
  },

  /**
   * @name getSellerShopId
   * @method
   * @memberof Core/Client
   * @param {String} userId User ID, default to current logged in user
   * @param {Boolean} noFallback If true, don't fall back to the current shop ID. Default `false`
   * @returns {String|Boolean} The seller shop ID or `false`
   */
  getSellerShopId(userId = getUserId(), noFallback = false) {
    if (userId) {
      const group = Roles.getGroupsForUser(userId, "admin")[0];
      if (group) {
        return group;
      }
    }

    if (noFallback) {
      return false;
    }

    return this.getShopId();
  },

  /**
   * primaryShopId is the first created shop. In a marketplace setting it's
   * the shop that controls the marketplace and can see all other shops.
   * @name primaryShopId
   * @memberof Core/Client
   */
  get primaryShopId() {
    return this._primaryShopId.get();
  },

  /**
   * @name getPrimaryShopId
   * @method
   * @memberof Core/Client
   * @returns {String} Primary shop ID
   */
  getPrimaryShopId() {
    return this._primaryShopId.get();
  },

  /**
   * @name getPrimaryShopName
   * @method
   * @memberof Core/Client
   * @returns {String} Primary shop name or empty string
   */
  getPrimaryShopName() {
    const shopId = this.getPrimaryShopId();
    const shop = Shops.findOne({
      _id: shopId
    });

    if (shop && shop.name) {
      return shop.name;
    }

    // If we can't find the primaryShop return an empty string
    return "";
  },

  /**
   * @name getPrimaryShopSettings
   * @method
   * @memberof Core/Client
   * @returns {String} Primary shop settings or empty object
   */
  getPrimaryShopSettings() {
    const settings = Packages.findOne({
      name: "core",
      shopId: this.getPrimaryShopId()
    }) || {};
    return settings.settings || {};
  },

  /**
   * @name getPrimaryShopCurrency
   * @method
   * @memberof Core/Client
   * @returns {String} Primary shop currency code, default USD.
   */
  getPrimaryShopCurrency() {
    const shop = Shops.findOne({
      _id: this.getPrimaryShopId()
    });

    return (shop && shop.currency) || "USD";
  },

  /**
   * @name getCurrentShop
   * @summary Get the proper current shop based on various checks. This mirrors the logic in
   *   Reaction.getShopId on the server
   * @method
   * @memberof Core/Client
   * @returns {Object|null} The shop document
   */
  getCurrentShop() {
    // Give preference to shop chosen by the user
    const activeShopId = this.getUserShopId();
    if (activeShopId) return Shops.findOne({ _id: activeShopId });

    // If no chosen shop, look up the shop by domain
    let shop = Shops.findOne({ domains: this.getDomain() });

    // Finally fall back to primary shop
    if (!shop) shop = Shops.findOne({ shopType: "primary" });

    return shop;
  },

  /**
   * @name getUserShopId
   * @method
   * @memberof Core/Client
   * @summary Get current user's shop ID, as stored in preferences
   * @return {String} active shop ID
   */
  getUserShopId() {
    const preferences = userPrefs.get(); // reactivity on `profile.preferences` changes only
    if (!preferences) return null;

    return _.get(preferences, "reaction.activeShopId");
  },

  /**
   * shopId refers to the active shop. For most shoppers this will be the same
   * as the primary shop, but for administrators this will usually be the shop
   * they administer.
   * @name shopId
   * @memberof Core/Client
   */
  get shopId() {
    return this._shopId.get();
  },

  /**
   * shopId refers to the active shop. For most shoppers this will be the same
   * as the primary shop, but for administrators this will usually be the shop
   * they administer.
   * @name getShopId
   * @method
   * @memberof Core/Client
   * @returns {String} The current shop ID in state, or activeShopId stored in account preferences for admins
   */
  getShopId() {
    return this.shopId || this.getUserShopId();
  },

  /**
   * shopId refers to the active shop. For most shoppers this will be the same
   * as the primary shop, but for administrators this will usually be the shop
   * they administer.
   * @name shopId
   * @memberof Core/Client
   * @param {String} id ID to set as the current shop in global app state
   * @returns {undefined}
   */
  set shopId(id) {
    this._shopId.set(id);
  },

  /**
   * shopId refers to the active shop. For most shoppers this will be the same
   * as the primary shop, but for administrators this will usually be the shop
   * they administer.
   * @name setShopId
   * @method
   * @memberof Core/Client
   * @param {String} id ID to set as the current shop in global app state
   * @returns {undefined}
   */
  setShopId(id) {
    if (!id || this.shopId === id) { return; }

    this.shopId = id;
    Meteor.call("accounts/setActiveShopId", id);
  },

  /**
   * @name isShopPrimary
   * @summary Whether the current shop is the Primary Shop (vs a Merchant Shop)
   * @return {Boolean} True if current shop from global app state is the primary shop for this Reaction installation
   */
  isShopPrimary() {
    return this.getShopId() === this.getPrimaryShopId();
  },

  /**
   * @name getShopName
   * @method
   * @memberof Core/Client
   * @summary gets name of shop by provided shopId, or current active shop if shopId is not provided
   * @param {String} providedShopId - shopId of shop to return name of
   * @return {String} - shop name
   */
  getShopName(providedShopId) {
    const shopId = providedShopId || this.getShopId();
    const shop = Shops.findOne({
      _id: shopId
    });
    return shop && shop.name;
  },

  /**
   * @name getShopSettings
   * @method
   * @memberof Core/Client
   * @returns {Object} Shop settings or empty object for current shop
   */
  getShopSettings() {
    const settings = Packages.findOne({
      name: "core",
      shopId: this.shopId
    }) || {};
    return settings.settings || {};
  },

  /**
   * @name getShopLanguage
   * @method
   * @memberof Core/Client
   * @returns {String} Language code or empty string for the current shop
   */
  getShopLanguage() {
    const shopId = this.getShopId();
    const shop = Shops.findOne({ _id: shopId });
    return shop ? shop.language : "";
  },

  async getSlug(slugString) {
    const lazyLoadSlugify = async () => {
      let mod;
      const lang = this.getShopLanguage();

      // If slugify has been loaded but language has changed to non latin-based language, load transliteration
      if (slugify && slugify.name === "replace" && latinLangs.indexOf(lang) === -1) {
        mod = await import("transliteration");
      } else if (slugify) {
        // If slugify/transliteration is loaded & no lang change
        return;
      } else if (latinLangs.indexOf(lang) >= 0) {
        // If shop's language uses latin based chars, load slugify, else load transliteration's slugify
        mod = await import("slugify");
      } else {
        mod = await import("transliteration");
      }

      // Slugify is exported to modules.default while transliteration is exported to modules.slugify
      slugify = mod.default || mod.slugify;
    };

    let slug;
    await lazyLoadSlugify(); // eslint-disable-line promise/catch-or-return
    if (slugString && slugify) {
      slug = slugify(slugString.toLowerCase());
    } else {
      slug = "";
    }
    return slug;
  },

  /**
   * @param {String} value New `viewAs` value
   * @returns {undefined}
   */
  setAdminViewAs(value) {
    const packageSettings = store.get("reaction-dashboard") || {};
    packageSettings.viewAs = value;
    store.set("reaction-dashboard", packageSettings);

    if (value === "customer") {
      this.hideActionView();
    }

    // Cause `Reaction.isPreview` calls to rerun
    getDep("reaction-dashboard.viewAs").changed();
  },

  /**
   * @summary Toggle preview mode on or off. Applies only to admins.
   * @returns {undefined}
   */
  togglePreviewMode() {
    const packageSettings = store.get("reaction-dashboard") || {};
    if (packageSettings.viewAs === "customer") {
      this.setAdminViewAs("administrator");
    } else {
      this.setAdminViewAs("customer");
    }
  },

  /**
   * @name isPreview
   * @method
   * @memberof Core/Client
   * @returns {Boolean} True if viewing the admin dashboard as a customer
   */
  isPreview() {
    // Make this reactive
    getDep("reaction-dashboard.viewAs").depend();

    const packageSettings = store.get("reaction-dashboard") || {};
    return packageSettings.viewAs === "customer";
  },

  /**
   * @name getPackageSettings
   * @method
   * @memberof Core/Client
   * @param {String} name The package name
   * @returns {Object|undefined} The `Packages` doc for the current shop, by package name
   */
  getPackageSettings(name) {
    const shopId = this.getShopId();
    const query = { name };

    if (shopId) {
      query.shopId = shopId;
    }

    return Packages.findOne(query);
  },

  /**
   * @name allowGuestCheckout
   * @method
   * @memberof Core/Client
   * @returns {Boolean} True if guest checkout is allowed for the current shop
   */
  allowGuestCheckout() {
    const settings = this.getShopSettings();
    // we can disable in admin, let's check.
    return !!(settings.public && settings.public.allowGuestCheckout);
  },

  /**
   * (similar to server/api canInviteToGroup)
   * @name canInviteToGroup
   * @method
   * @memberof Core/Client
   * @summary checks if the user making the request is allowed to make invitation to that group
   * @param {Object} options -
   * @param {Object} options.group - group to invite to
   * @param {Object} options.user - user object  making the invite (Meteor.user())
   * @return {Boolean} -
   */
  canInviteToGroup(options) {
    const { group } = options;
    let { user } = options;
    if (!user) {
      user = Meteor.user();
    }
    const userPermissions = user.roles[group.shopId];
    const groupPermissions = group.permissions;

    // granting invitation right for user with `owner` role in a shop
    if (this.hasPermission(["owner"], getUserId(), group.shopId)) {
      return true;
    }

    // checks that userPermissions includes all elements from groupPermissions
    // we are not using Reaction.hasPermission here because it returns true if the user has at least one
    return _.difference(groupPermissions, userPermissions).length === 0;
  },

  /**
   * @name showActionView
   * @method
   * @memberof Core/Client
   * @param {String} viewData {label, template, data}
   * @returns {String} Session "admin/showActionView"
   */
  showActionView(viewData) {
    Session.set("admin/showActionView", true);
    this.setActionView(viewData);
  },

  /**
   * @name isActionViewOpen
   * @method
   * @memberof Core/Client
   * @returns {Boolean} True if action view is open
   */
  isActionViewOpen() {
    return Session.equals("admin/showActionView", true);
  },

  /**
   * @name isActionViewDetailOpen
   * @method
   * @memberof Core/Client
   * @returns {Boolean} True if action view detail is open
   */
  isActionViewDetailOpen() {
    return Session.equals("admin/showActionViewDetail", true);
  },

  /**
   * @name setActionView
   * @method
   * @memberof Core/Client
   * @param {Object} viewData New view data for admin action view
   * @returns {undefined}
   */
  setActionView(viewData) {
    this.hideActionViewDetail();
    if (viewData) {
      let viewStack;

      if (Array.isArray(viewData)) {
        viewStack = viewData;
      } else {
        viewStack = [viewData];
      }

      Session.set("admin/actionView", viewStack);
    } else {
      const registryItem = this.getRegistryForCurrentRoute("settings");

      if (registryItem) {
        this.setActionView(registryItem);
      } else {
        this.setActionView({
          template: "blankControls"
        });
      }
    }
  },

  /**
   * @name pushActionView
   * @method
   * @memberof Core/Client
   * @param {Object} viewData New view data for admin action view stack
   * @returns {undefined}
   */
  pushActionView(viewData) {
    Session.set("admin/showActionView", true);

    const actionViewStack = Session.get("admin/actionView");

    if (viewData) {
      actionViewStack.push(viewData);
      Session.set("admin/actionView", actionViewStack);
    } else {
      const registryItem = this.getRegistryForCurrentRoute("settings");

      if (registryItem) {
        this.pushActionView(registryItem);
      } else {
        this.pushActionView({ template: "blankControls" });
      }
    }
  },

  /**
   * @name isActionViewAtRootView
   * @method
   * @memberof Core/Client
   * @returns {Boolean} True if the action view stack has only one item
   */
  isActionViewAtRootView() {
    const actionViewStack = Session.get("admin/actionView");

    if (Array.isArray(actionViewStack) && actionViewStack.length === 1) {
      return true;
    }

    return false;
  },

  /**
   * @name popActionView
   * @method
   * @memberof Core/Client
   * @returns {undefined}
   */
  popActionView() {
    const actionViewStack = Session.get("admin/actionView");
    actionViewStack.pop();

    Session.set("admin/actionView", actionViewStack);

    this.setActionViewDetail({}, { open: false });
  },

  /**
   * @name setActionViewDetail
   * @method
   * @memberof Core/Client
   * @param {Object} viewData New view data for admin action view
   * @param {Object} options Options
   * @param {Boolean} options.open Set to `false` to not automatically open the action view detail
   * @returns {undefined}
   */
  setActionViewDetail(viewData, options = {}) {
    const { open } = options;

    Session.set("admin/showActionView", true);
    Session.set("admin/showActionViewDetail", typeof open === "boolean" ? open : true);
    Session.set("admin/detailView", [viewData]);
  },

  /**
   * @name pushActionViewDetail
   * @method
   * @memberof Core/Client
   * @param {Object} viewData New view data for admin action view
   * @returns {undefined}
   */
  pushActionViewDetail(viewData) {
    Session.set("admin/showActionView", true);
    Session.set("admin/showActionViewDetail", true);

    const detailViewStack = Session.get("admin/detailView");

    if (viewData) {
      detailViewStack.push(viewData);
      Session.set("admin/detailView", detailViewStack);
    }
  },

  /**
   * @name popActionViewDetail
   * @method
   * @memberof Core/Client
   * @returns {undefined}
   */
  popActionViewDetail() {
    const detailViewStack = Session.get("admin/detailView");
    detailViewStack.pop();

    Session.set("admin/detailView", detailViewStack);
  },

  /**
   * @name isActionViewDetailAtRootView
   * @method
   * @memberof Core/Client
   * @returns {Boolean} True if the detail view stack has only one item
   */
  isActionViewDetailAtRootView() {
    const actionViewDetailStack = Session.get("admin/detailView");

    if (Array.isArray(actionViewDetailStack) && actionViewDetailStack.length === 1) {
      return true;
    }

    return false;
  },

  /**
   * @name getActionView
   * @method
   * @memberof Core/Client
   * @returns {undefined}
   */
  getActionView() {
    const actionViewStack = Session.get("admin/actionView");

    if (Array.isArray(actionViewStack) && actionViewStack.length) {
      return actionViewStack.pop();
    }

    return {};
  },

  /**
   * @name getActionViewDetail
   * @method
   * @memberof Core/Client
   * @returns {Object} The top detail view data or empty object
   */
  getActionViewDetail() {
    const detailViewStack = Session.get("admin/detailView");

    if (Array.isArray(detailViewStack) && detailViewStack.length) {
      return detailViewStack.pop();
    }

    return {};
  },

  /**
   * @name hideActionView
   * @method
   * @memberof Core/Client
   * @returns {undefined}
   */
  hideActionView() {
    Session.set("admin/showActionView", false);
    this.clearActionView();
  },

  /**
   * @name hideActionViewDetail
   * @method
   * @memberof Core/Client
   * @returns {undefined}
   */
  hideActionViewDetail() {
    Session.set("admin/showActionViewDetail", false);
    this.clearActionViewDetail();
  },

  /**
   * @name clearActionView
   * @method
   * @memberof Core/Client
   * @returns {undefined}
   */
  clearActionView() {
    Session.set("admin/actionView", [{
      label: "",
      i18nKeyLabel: ""
    }]);
    Session.set("admin/detailView", [{
      label: "",
      i18nKeyLabel: ""
    }]);
  },

  /**
   * @name clearActionViewDetail
   * @method
   * @memberof Core/Client
   * @returns {undefined}
   */
  clearActionViewDetail() {
    Session.set("admin/detailView", [{
      label: "",
      i18nKeyLabel: ""
    }]);
  },

  /**
   * @name getCurrentTag
   * @method
   * @memberof Core/Client
   * @returns {String|null} The slug for the current tag, if currently on a tag route
   */
  getCurrentTag() {
    if (this.Router.getRouteName() === "tag") {
      return this.Router.current().params.slug;
    }
    return null;
  },

  /**
   * @name getRegistryForCurrentRoute
   * @method
   * @memberof Core/Client
   * @param {String} provides The `provides` value to query for, default "dashboard"
   * @returns {Object} Registry settings for the current route
   */
  getRegistryForCurrentRoute(provides = "dashboard") {
    this.Router.watchPathChange();
    const currentRouteName = this.Router.getRouteName();
    const currentRoute = this.Router.current();
    const { template } = currentRoute.route.options;
    // find registry entries for routeName
    const reactionApp = Packages.findOne({
      "registry.name": currentRouteName,
      "registry.provides": provides,
      "enabled": true
    }, {
      enabled: 1,
      registry: 1,
      route: 1,
      name: 1,
      label: 1,
      settings: 1
    });

    // valid application
    if (reactionApp) {
      const settingsData = _.find(reactionApp.registry, (item) => item.provides && item.provides.includes(provides) && item.template === template);
      return settingsData;
    }
    Logger.debug("getRegistryForCurrentRoute not found", template, provides);
    return {};
  },

  /**
   * @name getMarketplaceSettings
   * @method
   * @memberof Core/Client
   * @summary finds the enabled `reaction-marketplace` package for the primary shop and returns the settings
   * @return {Object} The marketplace settings from the primary shop or undefined
   */
  getMarketplaceSettings() {
    const marketplaceSettings = Packages.findOne({
      name: "reaction-marketplace",
      shopId: this.getPrimaryShopId(), // the primary shop always owns the marketplace settings
      enabled: true // only use the marketplace settings if marketplace is enabled
    });

    return marketplaceSettings && marketplaceSettings.settings;
  },

  /**
   * @name getCartShopId
   * @method
   * @memberof Core
   * @summary Get the correct shop ID to use for Cart collection
   * @return {StringId} The primary or current shop ID, depending on merchantCart setting
   */
  getCartShopId() {
    const marketplaceSettings = this.getMarketplaceSettings();
    let shopId;
    if (marketplaceSettings && marketplaceSettings.public && marketplaceSettings.public.merchantCart) {
      shopId = this.getShopId();
    } else {
      shopId = this.getPrimaryShopId();
    }
    return shopId;
  }

};

/**
 * Create a client-side only collection of Countries for a dropdown form
 * properly sorted*
 * @name createCountryCollection
 * @method
 * @param {Object} countries -  The countries array on the Shop collection
 * @returns {Array} countryOptions - Sorted array of countries
 * @private
 */
function createCountryCollection(countries) {
  check(countries, Object);
  const countryOptions = [];
  for (const locale in countries) {
    if ({}.hasOwnProperty.call(countries, locale)) {
      const country = countries[locale];
      countryOptions.push({
        label: country.name,
        value: locale
      });
    }
  }
  countryOptions.sort((itemA, itemB) => {
    if (itemA.label < itemB.label) {
      return -1;
    }
    if (itemA.label > itemB.label) {
      return 1;
    }
    return 0;
  });

  for (const country of countryOptions) {
    Countries.insert(country);
  }
  return countryOptions;
}

/**
 * Gets the dependency for the key if available, else creates
 * a new dependency for the key and returns it.
 * @name getDep
 * @method
 * @param {String} key The key to get the dependency for
 * @returns {Tracker.Dependency} Tracker dependency instance
 * @private
 */
function getDep(key) {
  if (!deps.has(key)) {
    deps.set(key, new Tracker.Dependency());
  }
  return deps.get(key);
}
