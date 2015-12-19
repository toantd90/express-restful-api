var _ = require('lodash'),
    util = require('util'),
    moment = require('moment'),
    async = require('async'),
    path = require('path'),
    fs   = require('fs-extra'),
    crypto = require('crypto'),
    validate = require('./validate'),
    resutils = require('./resutils'),
    apidoc = require('apidoc'),
    pluralize = require('pluralize');

var Creator = function(mongoose, router){
  this.mongoose = mongoose;
  this.router = router;
  this.models = {};
  this.schemas = {};
  this.attrs = {};
  this.docs = [];
};

Creator.prototype = {

  createDoc: function(doc){
    var source = path.join( doc.dest, 'apicomment.js' );

    if(fs.existsSync(source)){
      fs.unlinkSync(source);
    }

    fs.mkdirsSync(doc.dest);
    fs.writeFileSync(path.join( doc.dest, 'apidoc.json'), JSON.stringify(doc));
    fs.writeFileSync(source, this.docs.join('\n'));

    apidoc.createDoc({
      src: doc.dest,
      dest: doc.dest,
      config: doc.dest
    });
  },

  doc: function(doc){
    var group = doc.group.substr(0,1).toUpperCase() + doc.group.substr(1),
        attrs = this.attrs,
        schemas = this.schemas,
        apiParam   = doc.method === 'post' ?
                     _.map(attrs[doc.group], function(attr, key){
                       return attr.children ? '' : 
                              '@apiParam {'+
                                 (attr.type === 'number' ? 'Number' :
                                  attr.instance          ? 'Object' : 'String')+
                               '} ' + key + ' ' + 
                                 (attr.desc     ? attr.desc :
                                  attr.instance ? attr.instance + ' id' : '');
                     }).join('\n * ') : '',
        apiSuccess = doc.method !== 'get' ? '' :
                     doc.collection ? [
                       '@apiSuccess {Number} offset',
                       '@apiSuccess {Number} limit',
                       '@apiSuccess {Number} size',
                       '@apiSuccess {String} first',
                       '@apiSuccess {String} last',
                       '@apiSuccess {String} prev',
                       '@apiSuccess {String} next',
                       '@apiSuccess {Object[]} items Array of '+group+' instance',
                     ].join('\n * ') : 
                     _.map(schemas[doc.group], function(schema, key){
                       var attr = attrs[doc.group][key] || {};
                       return '@apiSuccess {'+
                                 (attr.type === 'number'         ? 'Number' :
                                  attr.children || attr.instance ? 'Object' : 'String')+
                               '} ' + key + ' ' + 
                                 (attr.desc                      ? attr.desc :
                                  attr.children || attr.instance ? 'linking of ' + ( attr.children || attr.instance ) : '');
                     }).join('\n * ');

    this.docs.push(
      '/**\n'+
      ' * @api {'+doc.method+'} '+doc.url+' '+doc.name+'\n'+
      ' * @apiGroup '+group+ '\n' +
      ' * ' + apiParam     + '\n' +
      ' * ' + apiSuccess   + '\n' +
      ' */\n'
    );
  },

  model: function(key, attr){
    var schemaType = {},
        model;

    _.assign(attr, {
      id: {},
      createdAt: {
        type: 'date'
      },
      updatedAt: {
        type: 'date'
      }
    });

    _.each(attr, function(attr, name){
      schemaType[name] = attr.type === 'number' ? Number : 
                         attr.type === 'date'   ? Date   :
                         attr.children          ? Array  : String;
    });

    schema = new this.mongoose.Schema(schemaType);
    schema.index({ id: 1 });

    model = this.mongoose.model(key, schema);
    this.models[key]  = model;
    this.schemas[key] = schemaType;
    this.attrs[key]   = attr;
  },

  fields: function(key) {
    return _.map(this.schemas[key], function(attr, name) {
      return name;
    }).join(' ');
  },

  params: function(model, req, isRaw){
    var params = {};
    _.map(model, function(option, key){
      var value = req.body[key] || req.params[key] || req.query[key] || '';

      if(option.children) {
        value = value ? value : [];
      } else {
        value = value ? value : '';
      }

      if(_.isArray(value) ? value.length : value) {
        params[key] = value;
      }

    });
    return params;
  },

  cond: function(model, req ){
    var params = this.params( model, req, true ),
        cond = {};

    _.each(params, function(val, key){
      var type = model[key].type,
          search = type === 'number' || 
                   type === 'date'   ?  'range' : 'wildcard';

      val = val && val.length ? val : '';
      cond[key] = search === 'wildcard'                          ? new RegExp('^'+val.replace(/\*/g, '.*') + '$') : 
                  search === 'range' && /^\[.+\,.+\]$/.test(val) ? { 
                                                                     $gte: val.match(/^\[(.+)\,(.+)\]$/)[1],
                                                                     $lte: val.match(/^\[(.+)\,(.+)\]$/)[2]
                                                                   } : val;
    });
    return cond;
  },

  toObject: function(collection){
    return _.map(collection, function(instance){
      return instance.toObject ? instance.toObject() : instance;
    });
  },

  href: function(model, collectionKey, collection){

    collection = this.toObject(collection);
    _.each(model, function(option, key){
      var childrenCollectionKey,
          parentCollectionKey,
          instanceKey;
      if( option.children ){
        collection = _.map(collection, function(instance){
          instance[key] = {
            href: '/'+collectionKey+'/'+instance.id+'/'+key
          };
          return instance;
        });
      }

      if( option.parent ){
        parentCollectionKey = pluralize(option.parent.split('.')[0]);
        collection = _.map(collection, function(instance){
          instance[key] = {
            href: '/'+parentCollectionKey+'/'+instance[key]
          };
          return instance;
        });
      }

      if( option.instance ){

        instanceKey = option.instance;
        collection = _.map(collection, function(instance){
          instance[key] = {
            href: instance[key] ? '/'+pluralize(instanceKey)+'/'+instance[key] : null
          };
          return instance;
        });
      }
    });
    return collection;
  },

  getCollection: function(key, model){
    var that = this,
        keys = pluralize(key),
        fields = this.fields(key);

    /**
     * Return collection
     * @return {List of group object } 
     */
    this.doc({
      method: 'get',
      url : '/'+keys,
      group: key,
      name: 'Get collection',
      collection: true
    });
    this.router.get('/'+keys, function(req, res){
      var offset = Number(req.query.offset || 0),
          limit = Number(req.query.limit || 25),
          cond = that.cond(model, req),
          prev = offset - limit,
          next = offset + limit;

      async.waterfall([
        function(callback){
          that.models[key].find(cond, fields, {
            skip: offset,
            limit: limit
          }, function(err, collection){
            callback(err, collection);
          });
        },
        function(collection, callback){
          that.models[key].count(cond, function(err, size){
            callback(err, collection, size);
          });
        }
      ], function done(err, collection, size){
        resutils.accessControl(res, req);

        if(err) {
          resutils.error(res, err);
          return;
        }

        collection = that.href(model, keys, collection);

        var json = {
              offset: offset,
              limit: limit,
              size: size,
              first: size                 ? '/'+keys+'?offset=0&limit='+limit : null,
              last:  size                 ? '/'+keys+'?offset='+ ( ( Math.ceil( size / limit ) - 1 ) * limit ) + '&limit='+limit : null,
              prev:  size && offset !== 0 ? '/'+keys+'?offset='+ ( prev < 0 ? 0 : prev ) + '&limit='+limit : null,
              next:  size && next < size  ? '/'+keys+'?offset='+ next + '&limit='+limit : null,
              items: collection
            };

        res.json(json);
        res.end();
      });
    });
  },

  postInstance: function(key, model){
    var that = this,
        keys = pluralize(key);
    /**
     * Create new instance data and return instance URI with 201 status code
     */

    this.doc({
      method: 'post',
      url : '/'+keys,
      group: key,
      name: 'Create instance'
    });    
    this.router.post('/'+keys, function(req, res){
      var id,
          uniqKeys = _.chain(model)
                      .map(function(value, key){
                        return value.uniq ? key : undefined;
                      })
                      .compact()
                      .value(),
          md5 = crypto.createHash('md5'),
          params = that.params(model, req, true),
          process = [],
          results = validate(model, params);

      if( !results.ok ) {
        res.status(400).json( results );
        return;
      }

      id = uniqKeys.map(function(key){
        return params[key].replace(/[\s\.\/]+/g, '_').toLowerCase();
      }).join('-');

      if(!id){
        md5.update(new Date().getTime() + ':' + Math.random());
        id = md5.digest('hex').substr(0,7);
      }

      // Push key onto parent object
      _.each(model, function(attr){
        if(attr.parent) {
          var key = attr.parent.split('.')[0],
              child = attr.parent.split('.')[1];

          process = process.concat([
            function(callback){
              that.models[key].findOne({
                id: req.body[key]
              }, function(err, parent){
                  callback(err, parent);
              });
            },
            function(parent, callback){

              if(parent) {
                var now = moment().format();
                parent[child].push(id);
                parent.updatedAt = now;
                parent.save(function(err){
                  callback(err);
                });
              } else {
                callback(null);
              }
            }
          ]);
        }
      });

      process = process.concat([
        function(callback){
          var now = moment().format(),
              Model = that.models[key],
              instance = new Model(
                _.assign({
                    id: id
                }, params, {
                  createdAt: now,
                  updatedAt: now
                })
              );

          instance.save(function(err){
            callback(err);
          });

        }
      ]);

      async.waterfall(process, function done(err){
        resutils.accessControl(res, req);

        if(err) {
          resutils.error(res, err);
          return;
        }
        res.location('/'+keys+'/' + id );
        res.status(201).send(null);
      });
    });
  },

  getInstance: function(key, model){
    var that = this,
        keys = pluralize(key),
        fields = this.fields(key);

    /**
     * Get specified instance by ID
     */
    
    this.doc({
      method: 'get',
      url : '/'+keys+'/:id',
      group: key,
      name: 'Get instance',
      model: model      
    });
    this.router.get('/'+keys + '/:id', function(req, res){
      var id = req.params.id;

      async.waterfall([
        function(callback){
          that.models[key].findOne({
            id: id
          }, fields, function( err, instance ){
            if( !instance ) {
              err = new Error(key+' does not exists');
              err.code = 404;
            }

            callback(err, instance ? instance : {});
          });
        }
      ], function done(err, instance){
        resutils.accessControl(res, req);
        if(err) {
          resutils.error(res, err);
          return;
        }

        instance = that.href(model, keys, [instance])[0];

        res.send(instance);
      });
    });
  },

  getChildren: function(parentKey, attr, key, model){
    var that = this,
        parentKeys = pluralize(parentKey),
        keys = pluralize(attr.children),
        fields = this.fields(key);

    /**
     * /groups/uxd/members
     *
     * key: group
     * attr: { children: people }
     * key: members
     * model: {  }
     * 
     * Return children collection
     * @return children as collection
     */
    this.doc({
      method: 'get',
      url : '/'+parentKeys+'/:id/'+key,
      group: parentKey,
      name: 'Get '+key+' collection',
      collection: true
    });
    this.router.get('/'+parentKeys+'/:id/'+key, function(req, res){
      var id = req.params.id,
          offset = Number(req.query.offset || 0),
          limit = Number(req.query.limit || 25),
          prev = offset - limit,
          next = offset + limit,
          cond = that.cond(model, req);

      delete cond.id;
      cond[parentKey] = id;

      async.waterfall([
        function(callback){

          that.models[attr.children].find(cond, fields, {
            skip: offset,
            limit: limit            
          }, function(err, collection){
            callback(err, collection);
          });
        },
        function(collection, callback){

          that.models[attr.children].count(cond, function(err, size){
            callback(err, collection, size);
          });
        }
      ], function done(err, collection, size){
        resutils.accessControl(res, req);

        if(err) {
          resutils.error(res, err);
          return;
        }

        collection = that.href(model, keys, collection);

        var json = {
              offset: offset,
              limit: limit,
              size: size,
              first: size                 ? '/'+parentKeys+'/'+id+'/'+key+'?offset=0&limit='+limit : null,
              last:  size                 ? '/'+parentKeys+'/'+id+'/'+key+'?offset='+ ( ( Math.ceil( size / limit ) - 1 ) * limit ) + '&limit='+limit : null,
              prev:  size && offset !== 0 ? '/'+parentKeys+'/'+id+'/'+key+'?offset='+ ( prev < 0 ? 0 : prev ) + '&limit='+limit : null,
              next:  size && next < size  ? '/'+parentKeys+'/'+id+'/'+key+'?offset='+ next + '&limit='+limit : null,
              items: collection
            };

        res.json(json);
        res.end();
      });

    });

  },


  putAsUpdate: function(key, model){
    var that = this,
        keys = pluralize(key);

    /**
     * Update instance as full replacement with specified ID
     */
    this.doc({
      method: 'put',
      url : '/'+keys+'/:id',
      group: key,
      name: 'Update instance'
    });
    this.router.put('/' + keys + '/:id', function(req, res){
      var params = that.params( model, req );

      async.waterfall([
        function(callback){
          var now = moment().format();

          that.models[key].findOneAndUpdate({
            id: req.params.id
          }, _.assign(params, {
                updatedAt: now
          }), function(err, instance){
            callback(err);
          });
        }
      ], function done(err, instance){
        resutils.accessControl(res, req);

        if(err) {
          resutils.error(res, err);
          return;
        }

        res.status(200).send(null);
      });
    });
  },

  postAsUpdate: function(key, model){
    var that = this,
        keys = pluralize(key);

    /**
     * Update instance as partial replacement with specified ID
     */
    this.doc({
      method: 'post',
      url : '/'+keys+'/:id',
      group : key,
      name: 'Update instance'
    });    
    this.router.post('/' + keys + '/:id', function(req, res){
      var params = that.params( model, req, true );

      async.waterfall([
        function(callback){
          var now = moment().format();

          that.models[key].findOneAndUpdate({
            id: req.params.id
          }, _.assign(params, {
                updatedAt: now
          }), function(err, instance){
            callback(err);
          });
        }
      ], function done(err, instance){
        resutils.accessControl(res, req);

        if(err) {
          resutils.error(res, err);
          return;
        }

        res.status(200).send(null);
      });
    });
  },

  deleteCollection: function(key, model){
    var that = this,
        keys = pluralize(key);

    /**
     * Delete all collection
     * @return
     */
    this.doc({
      method: 'delete',
      url : '/'+keys,
      group: key,
      name: 'Delete collection'
    });
    this.router.delete('/'+keys, function(req, res){
      async.waterfall([
        function(callback){
          that.models[key].find(function(err, collection){

            async.map(collection, function(instance, callback){
              instance.remove(function(err){
                callback(err);
              });
            }, function(err){
              callback(err);
            });
          });
        }
      ], function done(err){
        resutils.accessControl(res, req);

        if(err) {
          resutils.error(res, err);
          return;
        }
        res.status(200).send(null);
      });
    });

  },

  deleteInstance: function(key, model){
    var that = this,
        keys = pluralize(key);

    /**
     * Delete specified instance
     * @return
     */
    this.doc({
      method: 'delete',
      url : '/'+keys+'/:id',
      group: key,
      name: 'Delete instance'
    });    
    this.router.delete('/'+keys+'/:id', function(req, res){
      async.waterfall([
        function(callback){
          that.models[key].findOneAndRemove({
            id: req.params.id
          }, function(err){
            callback(err);
          });
        }
      ], function done(err, instance){
        resutils.accessControl(res, req);

        if(err) {
          resutils.error(res, err);
          return;
        }

        res.status(200).send(null);
      });

    });
  }

};

module.exports = Creator;
