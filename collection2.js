// Extend the schema options allowed by SimpleSchema
SimpleSchema.extendOptions({
  index: Match.Optional(Match.OneOf(Number, String, Boolean)),
  unique: Match.Optional(Boolean),
  denyInsert: Match.Optional(Boolean),
  denyUpdate: Match.Optional(Boolean)
});

// Define some extra validation error messages
SimpleSchema.messages({
  notUnique: "[label] must be unique",
  insertNotAllowed: "[label] cannot be set during an insert",
  updateNotAllowed: "[label] cannot be set during an update"
});

/*
 * Public API
 */

var constructor = Meteor.Collection;
Meteor.Collection = function c2CollectionConstructor(name, options) {
  var self = this, ss;
  options = options || {};

  if (options.schema) {
    ss = options.schema;
    delete options.schema;
  }

  // Set up virtual fields by adding or augmenting the transform
  // before calling the constructor
  if (options.virtualFields) {
    options.transform = (function(userTransform, virtualFields) {
      return function(doc) {
        //add all virtual fields to document whenever it's passed to a callback
        _.each(virtualFields, function(func, fieldName) {
          doc[fieldName] = func(doc);
        });
        //support user-supplied transformation function as well
        return userTransform ? userTransform(doc) : doc;
      };
    })(options.transform, options.virtualFields);
    delete options.virtualFields;
  }

  // Call original Meteor.Collection constructor
  constructor.call(self, name, options);

  // Attach schema
  ss && self.attachSchema(ss);
};

// Make sure prototype and normal properties are kept
Meteor.Collection.prototype = constructor.prototype;

for (var prop in constructor) {
  if (constructor.hasOwnProperty(prop)) {
    Meteor.Collection[prop] = constructor[prop];
  }
}

/**
 * Meteor.Collection.prototype.attachSchema
 * @param  {SimpleSchema|Object} ss - SimpleSchema instance or a schema definition object from which to create a new SimpleSchema instance
 * @return {undefined}
 *
 * Use this method to attach a schema to a collection created by another package,
 * such as Meteor.users. It is most likely unsafe to call this method more than
 * once for a single collection, or to call this for a collection that had a
 * schema object passed to its constructor.
 */
Meteor.Collection.prototype.attachSchema = function c2AttachSchema(ss) {
  var self = this;

  if (!(ss instanceof SimpleSchema)) {
    ss = new SimpleSchema(ss);
  }

  self._c2 = {};
  self._c2._simpleSchema = ss;

  // Loop over fields definitions and ensure collection indexes (server side only)
  _.each(ss.schema(), function(definition, fieldName) {
    if (Meteor.isServer && 'index' in definition) {
      Meteor.startup(function() {
        var index = {};
        var indexValue = definition['index'];
        var indexName = 'c2_' + fieldName;
        if (indexValue === true)
          indexValue = 1;
        index[fieldName] = indexValue;
        var unique = !!definition.unique && (indexValue === 1 || indexValue === -1);
        var sparse = !!definition.optional && unique;
        if (indexValue !== false) {
          self._collection._ensureIndex(index, {
            background: true,
            name: indexName,
            unique: unique,
            sparse: sparse
          });
        } else {
          try {
            self._collection._dropIndex(indexName);
          } catch (err) {
            console.warn(indexName + " index does not exist.");
          }
        }
      });
    }
  });

  // Set up additional checks
  ss.validator(function() {
    var test, totalUsing, totalWillUse, sel;
    var def = this.definition;
    var val = this.value;
    var op = this.operator;
    var key = this.key;

    if (def.denyInsert && val !== void 0 && !op) {
      // This is an insert of a defined value into a field where denyInsert=true
      return "insertNotAllowed";
    }

    if (def.denyUpdate && op) {
      // This is an insert of a defined value into a field where denyUpdate=true
      if (op !== "$set" || (op === "$set" && val !== void 0)) {
        return "updateNotAllowed";
      }
    }

    // If a developer wants to ensure that a field is `unique` we do a custom
    // query to verify that another field with the same value does not exist.
    // (_skipClientUniqueCheck is for tests)
    if (def.unique && !self._skipClientUniqueCheck) {
      // If the value is not set we skip this test for performance reasons. The
      // authorization is exclusively determined by the `optional` parameter.
      if (val === void 0 || val === null)
        return true;

      // On the server if the field also have an index we rely on MongoDB to do
      // this verification -- which is a more efficient strategy.
      if (Meteor.isServer && [1, -1, true].indexOf(def.index) !== -1)
        return true;

      test = {};
      test[key] = val;
      if (op && op !== "$inc") { //updating
        sel = _.clone(self._c2._selector);
        if (!sel) {
          return true; //we can't determine whether we have a notUnique error
        } else if (typeof sel === "string") {
          sel = {_id: sel};
        }

        // Find count of docs where this key is already set to this value
        totalUsing = self.find(test).count();

        // Find count of docs that will be updated, where key
        // is not already equal to val
        // TODO this will overwrite if key is in selector already;
        // need more advanced checking
        sel[key] = {};
        sel[key]["$ne"] = val;
        totalWillUse = self.find(sel).count();

        // If more than one would have the val after update, it's not unique
        return totalUsing + totalWillUse > 1 ? "notUnique" : true;
      } else {
        return self.findOne(test) ? "notUnique" : true;
      }
    }

    return true;
  });

  // First define deny functions to extend doc with the results of clean
  // and autovalues. This must be done with "transform: null" or we would be
  // extending a clone of doc and therefore have no effect.
  self.deny({
    insert: function(userId, doc) {
      // If _id has already been added, remove it temporarily if it's
      // not explicitly defined in the schema.
      var id;
      if (Meteor.isServer && doc._id && !ss.allowsKey("_id")) {
        id = doc._id;
        delete doc._id;
      }

      // Referenced doc is cleaned in place
      ss.clean(doc, {
        isModifier: false,
        extendAutoValueContext: {
          isInsert: true,
          isUpdate: false,
          isUpsert: false,
          userId: userId,
          isFromTrustedCode: false
        }
      });

      // Add the ID back
      if (id) {
        doc._id = id;
      }

      return false;
    },
    update: function(userId, doc, fields, modifier) {

      // Referenced modifier is cleaned in place
      ss.clean(modifier, {
        isModifier: true,
        extendAutoValueContext: {
          isInsert: false,
          isUpdate: true,
          isUpsert: false,
          userId: userId,
          isFromTrustedCode: false
        }
      });

      return false;
    },
    fetch: [],
    transform: null
  });

  // Second define deny functions to validate again on the server
  // for client-initiated inserts and updates. These should be
  // called after the clean/autovalue functions since we're adding
  // them after. These must *not* have "transform: null" because
  // we need to pass the doc through any transforms to be sure
  // that custom types are properly recognized for type validation.
  self.deny({
    insert: function(userId, doc) {
      var ret = false;
      doValidate.call(self, "insert", [doc, {}, function(error) {
          if (error) {
            ret = true;
          }
        }], true, userId, false);

      return ret;
    },
    update: function(userId, doc, fields, modifier) {
      // NOTE: This will never be an upsert because client-side upserts
      // are not allowed once you define allow/deny functions
      var ret = false;
      doValidate.call(self, "update", [null, modifier, {}, function(error) {
          if (error) {
            ret = true;
          }
        }], true, userId, false);

      return ret;
    },
    fetch: []
  });

  // If insecure package is in use, we need to add allow rules that return
  // true. Otherwise, it would seemingly turn off insecure mode.
  if (Package && Package.insecure) {
    self.allow({
      insert: function() {
        return true;
      },
      update: function() {
        return true;
      },
      fetch: [],
      transform: null
    });
  }
  // If insecure package is NOT in use, then adding the two deny functions
  // does not have any effect on the main app's security paradigm. The
  // user will still be required to add at least one allow function of her
  // own for each operation for this collection. And the user may still add
  // additional deny functions, but does not have to.
};

Meteor.Collection.prototype.simpleSchema = function c2SS() {
  var self = this;
  return self._c2 ? self._c2._simpleSchema : null;
};

// Wrap DB write operation methods
_.each(['insert', 'update', 'upsert'], function(methodName) {
  var _super = Meteor.Collection.prototype[methodName];
  Meteor.Collection.prototype[methodName] = function () {
    var self = this, args = _.toArray(arguments);
    if (self._c2) {
      args = doValidate.call(self, methodName, args, false,
        (Meteor.isClient && Meteor.userId && Meteor.userId()) || null, Meteor.isServer);
      if (!args) {
        // doValidate already called the callback or threw the error
        if (methodName === "insert") {
          // insert should always return an ID to match core behavior
          return self._makeNewID();
        } else {
          return;
        }
      }
    }
    return _super.apply(self, args);
  };
});

/*
 * Private
 */

function doValidate(type, args, skipAutoValue, userId, isFromTrustedCode) {
  var self = this,
          schema = self._c2._simpleSchema,
          doc, callback, error, options, isUpsert;

  if (!args.length) {
    throw new Error(type + " requires an argument");
  }

  // Gather arguments and cache the selector
  self._c2._selector = null; //reset
  if (type === "insert") {
    doc = args[0];
    options = args[1];
    callback = args[2];

    // The real insert doesn't take options
    if (typeof options === "function") {
      args = [doc, options];
    } else if (typeof callback === "function") {
      args = [doc, callback];
    } else {
      args = [doc];
    }

  } else if (type === "update" || type === "upsert") {
    self._c2._selector = args[0];
    doc = args[1];
    options = args[2];
    callback = args[3];
  } else {
    throw new Error("invalid type argument");
  }

  // Support missing options arg
  if (!callback && typeof options === "function") {
    callback = options;
    options = {};
  }
  options = options || {};

  if (options.validate === false) {
    return args;
  }

  // If update was called with upsert:true or upsert was called, flag as an upsert
  isUpsert = (type === "upsert" || (type === "update" && options.upsert === true));

  // Add a default callback function if we're on the client and no callback was given
  if (Meteor.isClient && !callback) {
    // Client can't block, so it can't report errors by exception,
    // only by callback. If they forget the callback, give them a
    // default one that logs the error, so they aren't totally
    // baffled if their writes don't work because their database is
    // down.
    callback = function(err) {
      if (err)
        Meteor._debug(type + " failed: " + (err.reason || err.stack));
    };
  }

  // If _id has already been added, remove it temporarily if it's
  // not explicitly defined in the schema.
  var id;
  if (Meteor.isServer && doc._id && !schema.allowsKey("_id")) {
    id = doc._id;
    delete doc._id;
  }

  function doClean(docToClean, getAutoValues, filter, autoConvert) {
    // Clean the doc/modifier in place (removes any virtual fields added
    // by the deny transform, too)
    schema.clean(docToClean, {
      filter: filter,
      autoConvert: autoConvert,
      getAutoValues: getAutoValues,
      isModifier: (type !== "insert"),
      extendAutoValueContext: {
        isInsert: (type === "insert"),
        isUpdate: (type === "update" && options.upsert !== true),
        isUpsert: isUpsert,
        userId: userId,
        isFromTrustedCode: isFromTrustedCode
      }
    });
  }
  
  // Preliminary cleaning on both client and server. On the server, automatic
  // values will also be set at this point.
  doClean(doc, (Meteor.isServer && !skipAutoValue), true, true);

  // On the server, upserts are possible; SimpleSchema handles upserts pretty
  // well by default, but it will not know about the fields in the selector,
  // which are also stored in the database if an insert is performed. So we
  // will allow these fields to be considered for validation by adding them
  // to the $set in the modifier. This is no doubt prone to errors, but there
  // probably isn't any better way right now.
  var docToValidate = _.clone(doc);
  if (Meteor.isServer && isUpsert && _.isObject(self._c2._selector)) {
    var set = docToValidate.$set || {};
    docToValidate.$set = _.clone(self._c2._selector);
    _.extend(docToValidate.$set, set);
  }

  // Set automatic values for validation on the client.
  // On the server, we already updated doc with auto values, but on the client,
  // we will add them to docToValidate for validation purposes only.
  // This is because we want all actual values generated on the server.
  if (Meteor.isClient) {
    doClean(docToValidate, true, false, false);
  }

  // Validate doc
  var ctx = schema.namedContext(options.validationContext);
  var isValid = ctx.validate(docToValidate, {
    modifier: (type === "update" || type === "upsert"),
    upsert: isUpsert,
    extendedCustomContext: {
      isInsert: (type === "insert"),
      isUpdate: (type === "update" && options.upsert !== true),
      isUpsert: isUpsert,
      userId: userId,
      isFromTrustedCode: isFromTrustedCode
    }
  });

  // Clear the cached selector since it is only used during validation
  self._c2._selector = null;

  if (isValid) {
    // Add the ID back
    if (id) {
      doc._id = id;
    }
    // Update the args to reflect the cleaned doc
    if (type === "insert") {
      args[0] = doc;
    } else {
      args[1] = doc;
    }
    // If callback, set invalidKey when we get a mongo unique error
    var last = args.length - 1;
    if (typeof args[last] === 'function') {
      args[last] = wrapCallbackForNotUnique(self, doc, options.validationContext, args[last]);
    }
    return args;
  } else {
    var invalidKeys = ctx.invalidKeys();
    var message = "failed validation";
    if (invalidKeys.length) {
      var badKey = invalidKeys[0].name;
      message += ": " + badKey + ": " + ctx.keyErrorMessage(badKey);
    }
    error = new Error(message);
    error.invalidKeys = invalidKeys;
    if (callback) {
      // insert/update/upsert pass `false` when there's an error, so we do that
      callback(error, false);
    } else {
      throw error;
    }
  }
}

function wrapCallbackForNotUnique(col, doc, vCtx, cb) {
  return function (error) {
    if (error && ((error.name === "MongoError" && error.code === 11001) || error.message.indexOf('MongoError: E11000' !== -1)) && error.message.indexOf('c2_') !== -1) {
      var fName = error.message.split('c2_')[1].split(' ')[0];
      var mDoc = new MongoObject(doc);
      var info = mDoc.getInfoForKey(fName);
      var fVal = info ? info.value : void 0;
      col.simpleSchema().namedContext(vCtx)._invalidKeys.push({
        name: fName,
        type: 'notUnique',
        value: fVal,
        message: col.simpleSchema().messageForError('notUnique', fName, null, fVal)
      });
    }
    return cb.apply(this, arguments);
  };
}

// Backwards compatibility; Meteor.Collection2 is deprecated
Meteor.Collection2 = Meteor.Collection;