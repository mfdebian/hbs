const fs = require('fs');
const path = require('path');
const walk = require('walk').walk;
const create = require('handlebars').create;

const async = require('./async');

function Instance(handlebars = create()) {
  if (!(this instanceof Instance)) {
    return new Instance(handlebars);
  }

  // expose handlebars, allows users to use their versions
  // by overriding this early in their apps
  const self = this;

  self.handlebars = handlebars;

  // cache for templates, express 3.x doesn't do this for us
  self.cache = {};

  self.__express = middleware.bind(this);

  // queue for partials registration
  self._queue = null;

  // DEPRECATED, kept for backwards compatibility
  self.SafeString = this.handlebars.SafeString;
  self.Utils = this.handlebars.Utils;
}

// express 3.x template engine compliance
function middleware(filename, options, cb) {
  const self = this;

  if (self._queue) {
    self._queue.push(
      middleware.bind.apply(middleware, [this].concat(Array.from(arguments)))
    );
    return;
  }

  const cache = self.cache;
  const handlebars = self.handlebars;

  self.async = async();

  // grab extension from filename
  // if we need a layout, we will look for one matching out extension
  const extension = path.extname(filename);

  // Default handlebars runtime options
  const handlebarsOpts = {
    allowProtoMethodsByDefault: true,
    allowProtoPropertiesByDefault: true,
  };

  // If passing the locals as data, create the handlebars options object now
  if (self.__localsAsData) {
    handlebarsOpts.data = options._locals;
  }

  // render the original file
  // cb(err, str)
  function render_file(locals, cb) {
    // cached?
    const template = cache[filename];
    if (template) {
      try {
        let res = template(locals, handlebarsOpts);
        self.async.done(function (values) {
          Object.entries(values).forEach(([id, value]) => {
            res = res.replace(id, value);
          });

          cb(null, res);
        });
      } catch (err) {
        cb(prependFilenameToError(filename, err));
      }

      return;
    }

    fs.readFile(filename, 'utf8', function (err, str) {
      if (err) {
        return cb(err);
      }

      const template = handlebars.compile(str);
      if (locals.cache) {
        cache[filename] = template;
      }

      try {
        let res = template(locals, handlebarsOpts);
        self.async.done(function (values) {
          Object.entries(values).forEach(([id, value]) => {
            res = res.replace(id, value);
          });

          cb(null, res);
        });
      } catch (err) {
        cb(prependFilenameToError(filename, err));
      }
    });
  }

  // render with a layout
  function render_with_layout(filename, template, locals, cb) {
    render_file(locals, function (err, str) {
      if (err) {
        return cb(err);
      }

      locals.body = str;

      try {
        let res = template(locals, handlebarsOpts);
        self.async.done(function (values) {
          Object.entries(values).forEach(([id, value]) => {
            res = res.replace(id, value);
          });

          cb(null, res);
        });
      } catch (err) {
        cb(prependFilenameToError(filename, err));
      }
    });
  }

  let { layout, settings } = options;

  // user did not specify a layout in the locals
  // check global layout state
  if (
    layout === undefined &&
    options.settings &&
    options.settings['view options']
  ) {
    layout = settings['view options'].layout;
  }

  // user explicitly request no layout
  // either by specifying false for layout: false in locals
  // or by settings the false view options
  if (layout !== undefined && !layout) {
    return render_file(options, cb);
  }

  const layout_filename = [].concat(settings.views).map(function (view_dir) {
    let view_path = path.join(view_dir, layout || 'layout');

    if (!path.extname(view_path)) {
      view_path += extension;
    }

    return view_path;
  });

  const foundLayout = layout_filename.find((filename) => cache[filename]);
  if (foundLayout) {
    return render_with_layout(foundLayout, cache[foundLayout], options, cb);
  }

  // TODO check if layout path has .hbs extension

  function prependFilenameToError(filename, err) {
    // prepend to the message
    if (typeof err.message === 'string') {
      err.message = `${filename}: ${err.message}`;
    }

    return err;
  }

  function cacheAndCompile(filename, str) {
    const layout_template = handlebars.compile(str);
    if (options.cache) {
      cache[filename] = layout_template;
    }

    render_with_layout(filename, layout_template, options, cb);
  }

  function tryReadFileAndCache(templates) {
    const template = templates.shift();

    fs.readFile(template, 'utf8', function (err, str) {
      if (err) {
        if (layout && templates.length === 0) {
          // Only return error if user explicitly asked for layout.
          return cb(err);
        }

        if (templates.length > 0) {
          return tryReadFileAndCache(templates);
        }

        return render_file(options, cb);
      }

      cacheAndCompile(template, str);
    });
  }

  tryReadFileAndCache(layout_filename);
}

// express 2.x template engine compliance
Instance.prototype.compile = function (str) {
  if (typeof str !== 'string') {
    return str;
  }

  const template = this.handlebars.compile(str);
  return function (locals) {
    return template(locals, {
      helpers: locals.blockHelpers,
      partials: null,
      data: null,
    });
  };
};

Instance.prototype.registerHelper = function (...args) {
  this.handlebars.registerHelper.apply(this.handlebars, args);
};

Instance.prototype.registerPartial = function (...args) {
  this.handlebars.registerPartial.apply(this.handlebars, args);
};

Instance.prototype.registerPartials = function (directory, options, done) {
  const self = this;

  if (this._queue) {
    self._queue.unshift(
      self.registerPartials.bind.apply(
        self.registerPartials,
        [this].concat(Array.from(arguments))
      )
    );
    return;
  } else {
    self._queue = [];
  }

  let callback;
  const handlebars = self.handlebars;
  let opts = options || {};

  if (done || typeof options !== 'function') {
    callback = done;
  } else {
    callback = options;
    opts = {};
  }

  const rename =
    opts.rename !== undefined
      ? opts.rename
      : function (name) {
          return name.replace(/\-/g, '_');
        };

  const w = walk(directory);
  w.on('file', function (root, stat, done) {
    const filepath = path.join(root, stat.name);
    const isValidTemplate = /\.(html|hbs)$/.test(filepath);

    if (!isValidTemplate) {
      return done(null);
    }

    fs.readFile(filepath, 'utf8', function (err, data) {
      if (!err) {
        const extname = path.extname(filepath);
        const name = path
          .relative(directory, filepath)
          .slice(0, -extname.length)
          .replace(/\\/g, '/');

        handlebars.registerPartial(rename(name).replace(/ /g, '_'), data);
      }

      done(err);
    });
  });
  w.on('end', function () {
    if (self._queue) {
      const q = self._queue;

      self._queue = null;

      for (var i = 0; i < q.length; i++) {
        q[i]();
      }
    }
  });

  if (callback) {
    w.on('end', callback);
  }
};

Instance.prototype.registerAsyncHelper = function (name, fn) {
  const self = this;
  self.handlebars.registerHelper(name, function () {
    return self.async.resolve(fn.bind(this), arguments);
  });
};

Instance.prototype.localsAsTemplateData = function (app) {
  // Set a flag to indicate we should pass locals as data
  this.__localsAsData = true;

  app.render = (function (render) {
    return function (view, options, callback) {
      if (typeof options === 'function') {
        callback = options;
        options = {};
      }

      // Mix response.locals (options._locals) with app.locals (this.locals)
      options._locals = options._locals || {};
      Object.assign(options._locals, this.locals);

      return render.call(this, view, options, callback);
    };
  })(app.render);
};

module.exports = new Instance();
module.exports.create = function (handlebars) {
  return new Instance(handlebars);
};
