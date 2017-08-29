/* -*- mode: espresso; espresso-indent-level: 2; indent-tabs-mode: nil -*- */
/* vim: set softtabstop=2 shiftwidth=2 tabstop=2 expandtab: */

(function(CATMAID) {

  'use strict';

  /**
   * A skeleton rule filters accepts or reject a skeleton. Besides a filtering
   * strategy it has an optional list skeletons it is valid for. If this list is
   * not empty the application of this rule will be ignored for all other
   * skeletons.
   */
  CATMAID.SkeletonFilterRule = function(strategy, options, mergeMode, skid, name) {
    this.skip = false;
    this.mergeMode = mergeMode || CATMAID.UNION;
    this.strategy = strategy;
    this.options = options;
    this.validOnlyForSkid = skid;
    this.validOnlyForName = name;
  };

  var addToObject = function(o, key) {
    o[key] = true;
    return o;
  };

  CATMAID.SkeletonFilter= function(rules, skeletonIndex) {
    this.rules = rules;
    this.skeletonIndex = skeletonIndex;
    this.input = {};
  };


  /**
   * Fetch all arbors as compact arbors and parse them into an Arbor
   * instance, the positions, and the synapses, with the latter sorted in a
   * map of pre and post (0 and 1), and each with a map of partner skeleton ID
   * vs a map of treenode vs the number of times it is pre or post onto that
   * treenode.
   *
   * @params  {Array}   skeletonIds Skeletons to fetch
   * @returns {Promise}             Resolves with fetched arbors
   */
  CATMAID.SkeletonFilter.fetchArbors = function(skeletonIds, needsArbor,
      needsPartners, needsTags, needsTime, target) {
    return new Promise(function(resolve, reject) {
      var nns = CATMAID.NeuronNameService.getInstance();
      var arbors = target || {};
      fetchSkeletons(
        skeletonIds,
        function(skid) {
          var a = needsArbor ? "1" : "0";
          var p = needsPartners ? "1" : "0";
          var t = needsTags ? "1" : "0";
          return CATMAID.makeURL(project.id + '/' + skid + '/' + a + '/' + p + '/' + t + '/compact-arbor');
        },
        function(skid) {
          return {
            with_time: needsTime
          };
        },
        function(skid, json) {
          var arborInfo = arbors[skid] = {};
          if (needsArbor) {
            var ap = new CATMAID.ArborParser();
            ap.tree(json[0]);
            arborInfo.arborParser = ap;
            arborInfo.arbor = ap.arbor;
            arborInfo.positions = ap.positions;
            arborInfo.radii = json[0].reduce(function(o, row) {
              o[row[0]] = row[6];
              return o;
            }, {});
            arborInfo.nodesRaw = json[0];
          }

          if (needsTags) {
            arborInfo.tags = json[2];
          }

          if (needsPartners) {
            arborInfo.partnersRaw = json[1];
            arborInfo.partners = json[1].reduce(function(o, row) {
              // 1: treenode
              // 5: other skeleton ID
              // 6: 0 for pre and 1 for post
              var type = o[row[6]];
              var node = row[0];
              var other_skid = row[5];
              var nodes = type[other_skid];
              if (nodes) {
                var count = nodes[node];
                nodes[node] = count ? count + 1 : 1;
              } else {
                nodes = {};
                nodes[node] = 1;
                type[other_skid] = nodes;
              }
              return o;
            }, {0: {}, 1: {}}); // 0 is pre and 1 is post
          }
        },
        function(skid) {
          console.log("Could not load arbor" + nns.getName(skid) + "  #" + skid);
        },
        function() {
          resolve(arbors);
        },
        "GET");
    });
  };

  CATMAID.SkeletonFilter.loadVolumes = function(volumeIds, target) {
    var volumePromises = volumeIds.map(function(v) {
      return CATMAID.Volumes.get(project.id, v)
        .then(function(volume) {
          var meshes = CATMAID.Volumes.x3dToMeshes(volume.mesh);
          if (meshes.length < 1) {
            throw new CATMAID.ValueError("Can't create mesh for volume " + volume.id);
          }
          if (meshes.length > 1) {
            throw new CATMAID.ValueError("Too many meshes for volume " + volume.id);
          }
          target[volume.id] = {
            intersector: CATMAID.Volumes.makeIntersector(meshes[0])
          };
        });
    });
    return Promise.all(volumePromises);
  };

  var computeAxonArbor = function(arbor, positions, tags, partners) {
    // If there is a soma tag on a node, reroot arbor wrt. it
    if (tags && tags['soma'] && 1 === tags['soma'].length) {
      var soma = tags['soma'][0];
      if (arbor.root != soma) {
        // Rerooting modifies the arbor, use a copy for that
        arbor = arbor.clone();
        arbor.reroot(soma);
      }
    }

    var ap = new CATMAID.ArborParser();
    ap.arbor = arbor;
    ap.synapses(partners);

    return SynapseClustering.prototype.findAxon(ap, 0.9, positions);
  };


  /**
   * Return a promise that will resolve when all data dependencies for the
   * passed in sets of skeletons and filter rules. This ignores per-skeleton
   * constraints at the moment.
   */
  function prepareFilterInput(skeletonIds, rules, input) {
    var neededInput = new Set();
    for (var i=0; i<rules.length; ++i) {
      var rule = rules[i];
      if (!rule.strategy.prepare) {
        continue;
      }

      neededInput.addAll(rule.strategy.prepare);
    }

    var prepareActions = [];

    // If arbor, partners or tags are needed, we can use the fetchSkeletons API
    var needsArbor = neededInput.has("arbor"),
        needsPartners = neededInput.has("partners"),
        needsTags = neededInput.has("tags"),
        needsTime = neededInput.has("time"),
        needsIntervals = neededInput.has("intervals");

    if (needsArbor || needsTags || needsPartners) {
      if (input.skeletons === undefined) { input.skeletons = {}; }
      var fetchSkeletons = CATMAID.SkeletonFilter.fetchArbors(skeletonIds,
          needsArbor, needsPartners, needsTags, needsTime, input.skeletons);
      prepareActions.push(fetchSkeletons);
    }

    if (neededInput.has("volume")) {
      if (input.volumes === undefined) { input.volumes = {}; }
      var volumeIds = new Set();
      for (var i=0; i<rules.length; ++i) {
        var volumeId = rules[i].options['volumeId'];
        if (volumeId !== undefined) {
          volumeIds.add(volumeId);
        }
      }
      volumeIds = Array.from(volumeIds);
      prepareActions.push(CATMAID.SkeletonFilter.loadVolumes(volumeIds, input.volumes));
    }

    if (needsIntervals) {
      if (input.intervals === undefined) { input.intervals = []; }
      if (input.intervalIndex === undefined) { input.intervalIndex = {}; }
      var intervalRetrieval = Promise.resolve();
      var nRules = rules.length;
      for (var i=0; i<nRules; ++i) {
        var intervalId = rules[i].options['intervalId'];
        if (intervalId !== undefined) {
          intervalRetrieval = intervalRetrieval
            .then(function() {
              return CATMAID.fetch(project.id  + '/samplers/domains/intervals/' +
                  intervalId + '/details');
            })
            .then(function(interval) {
              return CATMAID.fetch(project.id + '/samplers/domains/' +
                  interval.domain_id + '/intervals');
            })
            .then(function(intervals) {
              var intervalIndex = input.intervalIndex;
              for (var i=0; i<intervals.length; ++i) {
                var interval = intervals[i];
                intervalIndex[interval.id] = interval;
              }
              if (nRules === 1) {
                input.intervals = intervals;
              }
            });

        }
      }
      if (nRules > 1) {
        intervalRetrieval = intervalRetrieval
          .then(function() {
            if (input.intervals) {
              input.intervals = input.intervals.keys().map(function(intervalId) {
                return this[intervalId];
              }, input.intervals);
            }
          });
      }
      prepareActions.push(intervalRetrieval);
    }

    return Promise.all(prepareActions)
      .then(function() {
        return input;
      });
  }

  function executeFilterRules(rules, skeletonIndex, inputMap, mapResultNode) {
    // Collect nodes in an object to allow fast hash based key existence
    // checks. Also collect the location of the node. Whether OR or AND is
    // used for merging is specified as option. For the sake of simplicity, a
    // strict left-associative combination is used.
    var nodeCollection = {};
    var radiiCollection = {};
    var skeletonCollection = new Set();
    var nNodes = 0;
    if (mapResultNode === undefined) {
      mapResultNode = function() {
        return true;
      };
    }
    var mergeNodeCollection = (function(skeletonId, other, mergeMode, mapNode) {
      var count = 0;
      if (CATMAID.UNION === mergeMode) {
        for (var node in other) {
          var existingNode = this[node];
          if (!existingNode) {
            this[node] = mapNode(skeletonId, node);
            ++count;
          }
        }
      } else if (CATMAID.INTERSECTION === mergeMode) {
        // An intersection keeps only nodes that both the target and the
        // other set have.
        for (var node in this) {
          var existingNode = other[node];
          if (!existingNode) {
            delete this[node];
            --count;
          }
        }
      } else {
        throw new CATMAID.ValueError("Unknown merge mode: " + mergeMode);
      }
      nNodes += count;
    }).bind(nodeCollection);

    var mergeSkeletonCollection = (function(other, mergeMode) {
      if (CATMAID.UNION === mergeMode) {
        for (var skeletonId of other) {
          this.add(skeletonId);
        }
      } else if (CATMAID.INTERSECTION === mergeMode) {
        for (var skeletonId of this) {
          if (!other.has(skeletonId)) {
            this.delete(skeletonId);
          }
        }
      } else {
        throw new CATMAID.ValueError("Unknown merge mode: " + mergeMode);
      }
    }).bind(skeletonCollection);

    // Get final set of points by going through all rules and apply them
    // either to all skeletons or a selected sub-set. Results of individual
    // rules are OR-combined.
    rules.forEach(function(rule, i) {
      // Pick source skeleton(s). If a rule requests to be only applied for
      // a particular skeleton, this working set will be limited to this
      // skeleton only.
      var sourceSkeletons;
      if (rule.validOnlyForSkid) {
        sourceSkeletons = {};
        sourceSkeletons[skid] = skeletons[skid];
      } else {
        sourceSkeletons = skeletonIndex;
      }

      // Ignore the merge mode for the first rule, because it can't be merge
      // with anything.
      var mergeMode = i === 0 ? CATMAID.UNION : rule.mergeMode;

      var allowedSkeletons = new Set();

      // Apply rules and get back a set of valid nodes for each skeleton
      Object.keys(sourceSkeletons).forEach(function(skid) {
        // Get valid point list from this skeleton with the current filter
        var neuron = skeletonIndex[skid];
        var nodeCollection = rule.strategy.filter(skid, neuron,
            inputMap, rule.options);
        // Merge all point sets for this rule. How this is done exactly (i.e.
        // OR or AND) is configured separately.
        if (nodeCollection && !CATMAID.tools.isEmpty(nodeCollection)) {
          mergeNodeCollection(skid, nodeCollection, mergeMode, mapResultNode);
          // Remember this skeleton as potentially valid
          allowedSkeletons.add(parseInt(skid, 10));
        }
      });

      mergeSkeletonCollection(allowedSkeletons, mergeMode);
    });

    return {
      nodes: nodeCollection,
      nNodes: nNodes,
      input: inputMap,
      skeletons: skeletonCollection
    };
  }

  /**
   * Run filter set on arbors and return a collection of matched nodes.
   *
   * @param {Object} skeletonArbors  Maps skeleton IDs to arbor info objects
   */
  CATMAID.SkeletonFilter.prototype.execute = function(mapResultNode, keepInputCache) {
    var rules = CATMAID.SkeletonFilter.getActiveRules(this.rules, this.skeletonIndex);

    var skeletonIndex = this.skeletonIndex;
    var skeletonIds = Object.keys(skeletonIndex);

    // Don't cache between executions by default
    if (!keepInputCache) {
      this.input = {};
    }
    return prepareFilterInput(skeletonIds, rules, this.input)
      .then(function(input) {
        return executeFilterRules(rules, skeletonIndex, input, mapResultNode);
      });
  };

  /**
   * Map a node collection returned by execute() into a list of points.
   *
   * @param {Object} skeletonArbors  Maps skeleton IDs to arbor info objects
   * @param {Bool}   addRadiusPoints Whether locations on a radius sphere around
   *                                 a node should be added as artificial points.
   * @param {Number} nNodes          Optional, to prevent Object.keys() call,
   *                                 the number of nodes in <nodeCollection>
   */
  CATMAID.SkeletonFilter.prototype.getNodeLocations = function(nodeCollection, addRadiusPoints, nNodes) {
    nNodes = nNodes === undefined ? Object.keys(nodeCollection).length : nNodes;
    // Get a list of node positions. They are used as input for the convex
    // hull creation.
    var points = new Array(nNodes);
    var added = 0;
    for (var nodeId in nodeCollection) {
      var pr = nodeCollection[nodeId];
      var p = pr[0];
      points[added] = p;
      ++added;
      // Optionally, 12 points on an icosphere with the node's radis around the
      // node itself can be added.
      var radius = pr[1];
      if (addRadiusPoints && radius && radius > 0) {
        var radiusPoints = CATMAID.getIcoSpherePoints(p[0], p[1], p[2], radius);
        for (var i=0; i<radiusPoints.length; ++i) {
          // Will be appended after pre-allocated slots, so that above logic
          // still works.
          points.push(radiusPoints[i]);
        }
      }
    }

    return points;
  };

  CATMAID.SkeletonFilter.getActiveRules = function(rules, skeletonIndex) {
    var nns = CATMAID.NeuronNameService.getInstance();

    if (!rules || 0 === rules.length) {
      rules = defaultFilterRuleSet;
    }
    // Extract the set of rules defining this compartment. Also validate
    // skeleton constraints if there are any.
    return rules.reduce(function(m, rule) {
      var valid = true;

      if (rule.skip) {
        valid = false;
      } else if (rule.validOnlyForSkid || rule.validOnlyForName) {
        var skid = rule.validOnlyForSkid;
        // Validate
        if (skid) {
          if (!skeletonIndex[skid]) {
            valid = false;
          }
          // Consider name only if a skeleton ID is given
          var name = rule.validOnlyForName;
          if (name && nns.getName(skid) !== name) {
            valid = false;
          }
        }
      }

      if (valid) {
        m.push(rule);
      }

      return m;
    }, []);
  };

  /**
   * Node filter strategies can be used in skeletotn filter rules. They select
   * individual nodes fom skeletons/arbors.
   */
  CATMAID.NodeFilterStrategy = {
    "take-all": {
      name: "Take all nodes of each skeleton",
      prepare: ["arbor"],
      filter: function(skeletonId, neuron, input, options) {
        var skeleton = input.skeletons[skeletonId];
        return skeleton.arbor.nodes();
      }
    },
    "endnodes": {
      name: "Only end nodes",
      prepare: ["arbor"],
      filter: function(skeletonId, neuron, input, options) {
        var skeleton = input.skeletons[skeletonId];
        var arbor = skeleton.arbor;
        var endIds = arbor.findBranchAndEndNodes().ends;
        var endNodes = {};
        var nodes = arbor.nodes();
        for (var i=0; i<endIds.length; ++i) {
          var nodeId = endIds[i];
          if (nodes.hasOwnProperty(nodeId)) {
            endNodes[nodeId] = nodes[nodeId];
          }
        }
        if (options.includeRoot) {
          var rootNode = nodes[arbor.root];
          if (rootNode) {
            endNodes[arbor.root] = rootNode;
          }
        }
        return endNodes;
      }
    },
    "branches": {
      name: "Only branch nodes",
      prepare: ["arbor"],
      filter: function(skeletonId, neuron, input, options) {
        var skeleton = input.skeletons[skeletonId];
        var arbor = skeleton.arbor;
        var branchIds = Object.keys(arbor.findBranchAndEndNodes().branches);
        var branchNodes = {};
        var nodes = arbor.nodes();
        for (var i=0; i<branchIds.length; ++i) {
          var nodeId = branchIds[i];
          if (nodes.hasOwnProperty(nodeId)) {
            branchNodes[nodeId] = nodes[nodeId];
          }
        }
        return branchNodes;
      }
    },
    // Options: tag
    'tags': {
      name: "Only tagged nodes",
      prepare: ["arbor", "tags"],
      filter: function(skeletonId, neuron, input, options) {
        var skeleton = input.skeletons[skeletonId];
        var tags = skeleton.tags;
        return tags[options.tag].reduce(addToObject, {}) || null;
      }
    },
    // Looks for soma tags on root nodes and make sure there is only one root
    // and only one soma tag in use on a neuron.
    "nuclei": {
      name: "Only nuclei",
      prepare: ["arbor", "tags"],
      filter: function(skeletonId, neuron, input, options) {
        var skeleton = input.skeletons[skeletonId];
        var arbor = skeleton.arbor;
        var tags = skeleton.tags;
        // Expect only one use of the soma tag
        var somaTaggedNodes = tags["soma"];
        if (!somaTaggedNodes || 1 !== somaTaggedNodes.length) {
          console.log("Skeleton #" + skeletonId +
              " does not have exactly one node tagged with 'soma'");
          return {};
        }
        // Expect only one root
        var nRoots = 0;
        for (var child in arbor.edges) {
          if (!arbor.edges[child]) {
            ++nRoots;
            if (nRoots > 1) {
              console.log("Skeleton #" + skeletonId +
                  " has more than one root node");
              return {};
            }
          }
        }
        return somaTaggedNodes.reduce(addToObject, {}) || null;
      }
    },
    // Options: tag, expected
    "subarbor": {
      name: "Use a sub-arbor starting from a tag",
      prepare: ["arbor", "tags"],
      filter: function(skeletonId, neuron, input, options) {
        var skeleton = input.skeletons[skeletonId];
        var arbor = skeleton.arbor;
        var tags = skeleton.tags;
        var cuts = tags[options.tag];
        if (!cuts || (options.expected && cuts.length !== options.expected)) {
          console.log("CANNOT extract dendrite for " + neuron.name + ", cuts: " + cuts);
          return {};
        }
        return cuts.reduce(function(nodes, cut) {
          return $.extend(nodes, arbor.subArbor(cut).nodes());
        }, {});
      }
    },
    // Options: tagStart, tagEnd
    "single-region": {
      name: "Use a region",
      prepare: ["arbor", "tags"],
      filter: function(skeletonId, neuron, input, options) {
        var skeleton = input.skeletons[skeletonId];
        var arbor = skeleton.arbor;
        var tags = skeleton.tags;
        var start_cuts = tags[options.tagStart];
        var end_cuts = tags[options.tagEnd];
        if (!start_cuts || start_cuts.length !== 1 || !end_cuts || end_cuts.length !== 1) {
          console.log("CANNOT extract dendrite for " + neuron.name + ", wrong cuts: start_cuts: " + start_cuts + ", end_cuts: " + end_cuts);
          return null;
        }
        var order = arbor.nodesOrderFrom(arbor.root);
        var start = start_cuts[0];
        var end = end_cuts[0];
        if (order[start] > order[end] || start === end) {
          console.log("CANNOT extract dendrite for " + neuron.name + ", wrong order of cuts: start_cuts: " + start_cuts + ", end_cuts: " + end_cuts);
          return null;
        }
        var sub1 = arbor.subArbor(start);
        sub1.subArbor(end).nodesArray().forEach(function(node) {
          delete sub1.edges[node];
        });
        return sub1.nodes();
      }
    },
    // Options: tag, region
    "binary-split": {
      name: "Binary split",
      prepare: ["arbor", "tags"],
      filter: function(skeletonId, neuron, input, options) {
        var skeleton = input.skeletons[skeletonId];
        var arbor = skeleton.arbor;
        var tags = skeleton.tags;
        var cuts = tags[options.tag];
        if (!cuts || cuts.length !== 1) {
          console.log("CANNOT extract dendrite for " + neuron.name + ", cuts: " + cuts);
          return null;
        }
        if ("downstream" === options.region) {
          return arbor.subArbor(cuts[0]).nodes();
        } else if ("upstream" === options.region) {
          var dend = arbor.clone();
          arbor.subArbor(cuts[0]).nodesArray().forEach(function(node) {
            delete dend.edges[node];
          });
          return dend.nodes();
        } else {
          console.log("CANNOT extract dendrite for " + neuron.name + ", unknown region: " + neuron.strategy.region);
          return null;
        }
      }
    },
    // Find the positions of the source skeleton nodes pre- or ppostsynaptic to
    // another set of skeletons.
    "synaptic": {
      name: "Synaptic connections to other neurons",
      prepare: ["partners"],
      filter: function(skeletonId, neuron, input, options) {
        var skeleton = input.skeletons[skeletonId];
        var partners = skeleton.partners;
        var selectedPartners;
        if ('pre' === options.relation) {
          selectedPartners = partners[0];
        } else if ('post' === options.relation) {
          selectedPartners = partners[1];
        } else if ('pre-or-post' === options.relation) {
          // Merge both pre and post connections into a new object
          selectedPartners = CATMAID.tools.deepCopy(partners[0]);
          for (var partnerId in partners[1]) {
            var postPartner = partners[1][partnerId];
            var p = selectedPartners[partnerId];
            if (p) {
              for (var treenodeId in postPartner) {
                p[treenodeId] = postPartner[treenodeId];
              }
            } else {
              selectedPartners[partnerId] = postPartner;
            }
          }
        } else {
          throw new CATMAID.ValuError("Unsupported relation: " + options.relation);
        }

        var synapticNodes = {};
        var partnerNeurons = options.otherNeurons;

        for (var partnerId in selectedPartners) {
          // Check if partners in option set are in actual partner set (or if
          // all partners should be used). Collect return all synaptic nodes
          // of the current skeleton
          if (!partnerNeurons || partnerNeurons[partnerId]) {
            var nodes = selectedPartners[partnerId];
            for (var nodeId in nodes) {
              synapticNodes[nodeId] = true;
            }
          }
        }

        return synapticNodes;
      }
    },
    "axon": {
      name: "Axon",
      prepare: ["arbor", "partners", "tags"],
      filter: function(skeletonId, neuron, input, options) {
        var skeleton = input.skeletons[skeletonId];
        var axon = computeAxonArbor(skeleton.arbor, skeleton.positions,
            skeleton.tags, skeleton.partnersRaw);
        return axon ? axon.nodes() : {};
      }
    },
    "dendrites": {
      name: "Dendrites",
      prepare: ["arbor", "partners", "tags"],
      filter: function(skeletonId, neuron, input, options) {
        var skeleton = input.skeletons[skeletonId];
        var axon = computeAxonArbor(skeleton.arbor, skeleton.positions,
            skeleton.tags, skeleton.partnersRaw);
        if (axon) {
          // Find all nodes not in axon
          var dendriteNodes = skeleton.arbor.nodes();
          var axonNodeIds = axon.nodesArray();
          for (var i=0, max=axonNodeIds.length; i<max; ++i) {
            delete dendriteNodes[axonNodeIds[i]];
          }
          return dendriteNodes;
        } else {
          return {};
        }
      }
    },
    "volume": {
      name: "Volume",
      prepare: ["arbor", "volume"],
      filter: function(skeletonId, neuron, input, options) {
        var skeleton = input.skeletons[skeletonId];
        var volume = input.volumes[options.volumeId];
        var intersector = volume.intersector;
        var positions = skeleton.positions;
        var nodes = skeleton.arbor.nodesArray();
        var includedNodes = {};
        for (var i=0, max=nodes.length; i<max; ++i) {
          var nodeId = nodes[i];
          var vertex = positions[nodeId];
          if (intersector.contains(vertex)) {
            includedNodes[nodeId] = nodes[nodeId];
          }
        }
        return includedNodes;
      }
    },
    'users': {
      name: "Created by user(s)",
      prepare: ["arbor"],
      filter: function(skeletonId, neuron, input, options) {
        var skeleton = input.skeletons[skeletonId];
        var nodes = skeleton.nodesRaw;
        var includedNodes = {};
        for (var i=0, max=nodes.length; i<max; ++i) {
          var node = nodes[i];
          if (options.userWhitelist.has(node[2])) {
            includedNodes[node[0]] = true;
          }
        }
        return includedNodes;
      }
    },
    'date': {
      name: "Date range",
      prepare: ["arbor", "time"],
      filter: function(skeletonId, neuron, input, options) {
        var skeleton = input.skeletons[skeletonId];
        var nodes = skeleton.nodesRaw;
        var includedNodes = {};
        var index = options.editionTime ? 9 : 8;
        var time = options.time;
        if (options.before) {
          for (var i=0, max=nodes.length; i<max; ++i) {
            var node = nodes[i];
            if (node[index] < time) {
              includedNodes[node[0]] = true;
            }
          }
        } else {
          for (var i=0, max=nodes.length; i<max; ++i) {
            var node = nodes[i];
            if (node[index] > time) {
              includedNodes[node[0]] = true;
            }
          }
        }
        return includedNodes;
      }
    },
    'strahler': {
      name: 'Strahler number',
      prepare: ['arbor'],
      filter: function(skeletonId, neuron, input, options) {
        var skeleton = input.skeletons[skeletonId];
        var arbor = skeleton.arbor;
        var nodes = arbor.nodesArray();
        var strahler = arbor.strahlerAnalysis();
        var value = CATMAID.tools.getDefined(options.strahlerValue, 2);
        var op = CATMAID.tools.getDefined(options.op, "greater");
        var includedNodes = {};
        if (op === "smaller") {
          for (var i=0; i<nodes.length; ++i) {
            var nodeId = nodes[i];
            var strahlerValue = strahler[nodeId];
            if (strahlerValue < value) {
              includedNodes[nodeId] = true;
            }
          }
        } else if (op === "same") {
          for (var i=0; i<nodes.length; ++i) {
            var nodeId = nodes[i];
            var strahlerValue = strahler[nodeId];
            if (strahlerValue == value) {
              includedNodes[nodeId] = true;
            }
          }
        } else if (op === "greater") {
          for (var i=0; i<nodes.length; ++i) {
            var nodeId = nodes[i];
            var strahlerValue = strahler[nodeId];
            if (strahlerValue > value) {
              includedNodes[nodeId] = true;
            }
          }
        } else {
          throw new CATMAID.ValueError("Unknown strahler filter operation: " + op);
        }
        return includedNodes;
      }
    },
    'sampler-interval': {
      name: "Sampler interval",
      prepare: ['arbor', 'intervals'],
      filter: function(skeletonId, neuron, input, options) {
        var skeleton = input.skeletons[skeletonId];
        var arbor = skeleton.arbor;
        var intervalId = options.intervalId;
        var interval = input.intervalIndex[intervalId];
        var otherIntervalBoundaries = input.intervals.reduce(
            function(o, testInterval) {
              if (intervalId !== testInterval.id &&
                  interval.start_node_id !== testInterval.end_node_id &&
                  interval.end_node_id !== testInterval.start_node_id) {
                o.add(testInterval.start_node_id);
                o.add(testInterval.end_node_id);
              }
              return o;
            }, new Set());

        try {
          var intervalNodes = CATMAID.Sampling.getIntervalNodes(arbor,
            interval.start_node_id, interval.end_node_id,
            otherIntervalBoundaries);

          var includedNodes = {};
          for (var nodeId of intervalNodes) {
            includedNodes[nodeId] = true;
          }
          return includedNodes;
        } catch (error) {
          return {};
        }
      }
    }
  };

  /**
   * A collection of UI creation methods for individual node filtering
   * strategies from CATMAID.NodeFilterStrategy members.
   */
  CATMAID.NodeFilterSettingFactories = {
    'take-all': function(container, options) {
      // Take all has no additional options
    },
    'endnodes': function(container, options) {
      // Option to include root
      var $includeRoot = CATMAID.DOM.createCheckboxSetting(
          "Include root node", false, "If checked, the root node will be treated as an end node.",
          function(e) { options.includeRoot = this.checked; });
      $(container).append($includeRoot);
    },
    'branches': function(container, options) {
      // There are no additional settings for branch node selection
    },
    'tags': function(container, options) {
      var $tag = CATMAID.DOM.createInputSetting("Tag", "",
          "A tag that every used node must have", function() {
            options.tag = this.value;
          });
      $(container).append($tag);
    },
    'nuclei': function(container, options) {
      // Nuclei has no additional options
    },
    'subarbor': function(container, options) {
      var $tag = CATMAID.DOM.createInputSetting("Tag", "",
          "A tag that every used node must have", function() {
            options.tag = this.value;
          });
      var $expected = CATMAID.DOM.createInputSetting("Expected", "",
          "Only take sub-arbor if tag is used the expected number of times",
          function() {
            options.expected = parseInt(this.value, 10);
          });
      $(container).append($tag);
      $(container).append($expected);
    },
    'single-region': function(container, options) {
      var $tagStart = CATMAID.DOM.createInputSetting("Start tag", "",
          "A tag used to find a node in a skeleton. The skelen is cut right before (upstream) this node, the remaining part is taken.", function() {
            options.tagStart = this.value;
          });
      var $tagEnd = CATMAID.DOM.createInputSetting("End tag", "",
          "A tag used to find a node in a skeleton. The skeleton is cut right before (upstream), the remaining part passes through the filter.", function() {
            options.tagEnd = this.value;
          });
      $(container).append($tagStart);
      $(container).append($tagEnd);
    },
    'binary-split': function(container, options) {
      // Default options
      options.region = "downstream";

      var $tag = CATMAID.DOM.createInputSetting("Tag", "",
          "Cut skeleton at tagged node", function() {
            options.tag = this.value;
          });
      var $region = CATMAID.DOM.createSelectSetting("Region",
          { "Downstream": "downstream", "Upstream": "upstream" },
          "Select which region relative to the cuts at tagged nodes should be allowed.",
          function() {
            options.region = this.value;
          }, options.region);

      $(container).append($tag);
      $(container).append($region);
    },
    'synaptic': function(container, options) {
      // Defaults
      options.relation = options.relation || 'post';
      // The skeleton source
      var availableSources = CATMAID.skeletonListSources.getSourceNames();
      var sourceOptions = availableSources.reduce(function(o, name) {
        o[name] = name;
        return o;
      }, {
        'None': 'None' // default to enforce active selection
      });

      var $otherNeurons = CATMAID.DOM.createSelectSetting("Source of synaptic neurons",
          sourceOptions, "Neurons from this source will be checked against having synapses with the working set. If \"None\" is selected, all synaptic nodes will be considered.",
          function(e) {
            // Get models from source to store in option set
            var source = this.value && this.value !== "None" ?
              CATMAID.skeletonListSources.getSource(this.value) : undefined;

            if (!source) {
              options.otherNeurons = null;
              return;
            }

            // Collect points based on current source list and current rule set
            options.otherNeurons = source.getSelectedSkeletonModels();
          }, 'None');

      var $relation = CATMAID.DOM.createSelectSetting("Relation of base set to above partners",
          { "Postsynaptic": "post", "Presynaptic": "pre" , "Pre- or postsynaptic": "pre-or-post"},
          "Select how a valid node of the base set (nodes to generate mesh) is related to partner neurons from other source.",
          function() {
            options.relation = this.value;
          }, options.relation);

      $(container).append($otherNeurons, $relation);
    },
    'axon': function(container, options) {
      // No additional options for axon filter
    },
    'dendrites': function(container, options) {
      // No additional options for dendrite filter
    },
    'volume': function(container, options) {
      // Update volume list
      var initVolumeList = function() {
        return CATMAID.Volumes.listAll(project.id).then(function(json) {
            var volumes = json.sort(function(a, b) {
              return CATMAID.tools.compareStrings(a.name, b.name);
            }).map(function(volume) {
              return {
                title: volume.name,
                value: volume.id
              };
            });
            var selectedVolume = options.volumeId;
            // Create actual element based on the returned data
            var node = CATMAID.DOM.createRadioSelect('Volumes', volumes, selectedVolume);
            // Add a selection handler
            node.onchange = function(e) {
              options.volumeId = e.target.value;
            };
            return node;
          });
      };

      // Create async selection and wrap it in container to have handle on initial
      // DOM location
      var volumeSelection = CATMAID.DOM.createAsyncPlaceholder(initVolumeList());
      var volumeSelectionWrapper = document.createElement('span');
      $(container).append(volumeSelection);
    },
    'users': function(container, options) {
      var allUsers = CATMAID.User.all();
      var userToId = Object.keys(allUsers).reduce(function(o, u) {
        o.set(allUsers[u].login, parseInt(u, 10));
        return o;
      }, new Map());
      var updateOptions = function() {
        if (!options.userWhitelist) {
          options.userWhitelist = new Set();
        }
        var userIds = $userFieldInput.val().split(',')
            .map(function(u) { return userToId.get(u.trim()); });
        options.userWhitelist.clear();
        options.userWhitelist.addAll(userIds);
      };

      var $userField = CATMAID.DOM.createInputSetting("Node creator", "",
          "Only nodes are allowed that were createad by one of the (comma separated) users",
          updateOptions);
      $(container).append($userField);

      var $userFieldInput = $('input', $userField);
      var updateUserField = function(event, ui) {
        var selectedUser = ui.item.label;
        var alreadySelected = this.value.split(',').map(function(u) { return u.trim(); });
        if (alreadySelected.indexOf(selectedUser) === -1) {
          alreadySelected.push(selectedUser);
        }
        $userFieldInput.val(alreadySelected.join(' ,'));
        updateOptions();
        return false;
      };

      $userFieldInput.autocomplete({
        source: Object.keys(allUsers).map(function(u) { return allUsers[u].login; }),
        select: updateUserField
      });
    },
    'date': function(container, options) {
      var dateLabel = document.createElement('label');
      dateLabel.appendChild(document.createTextNode('Date'));
      var date = document.createElement('input');
      date.setAttribute('name', 'date');
      date.setAttribute('size', '10');
      date.appendChild(document.createTextNode('date'));
      date.onchange = function() {
        options.time = new Date(this.value) / 1000;
      };
      dateLabel.appendChild(date);
      container.appendChild(dateLabel);

      $(date).datepicker({
        dateFormat: "yy-mm-dd"
      });

      var before = document.createElement('input');
      before.setAttribute('type', 'radio');
      before.setAttribute('name', 'date-relation');
      before.onchange = function() {
        options.before = true;
      };
      var beforeLabel = document.createElement('label');
      beforeLabel.appendChild(before);
      beforeLabel.appendChild(document.createTextNode('Before'));
      container.appendChild(beforeLabel);

      var after = document.createElement('input');
      after.setAttribute('type', 'radio');
      after.setAttribute('name', 'date-relation');
      after.setAttribute('checked', 'checked');
      after.onchange = function() {
        options.before = false;
      };
      var afterLabel = document.createElement('label');
      afterLabel.appendChild(after);
      afterLabel.appendChild(document.createTextNode('After'));
      container.appendChild(afterLabel);

      var creationTime = document.createElement('input');
      creationTime.setAttribute('type', 'radio');
      creationTime.setAttribute('name', 'date-type');
      creationTime.setAttribute('checked', 'checked');
      creationTime.onchange = function() {
        options.editionTime = false;
      };
      var creationTimeLabel = document.createElement('label');
      creationTimeLabel.appendChild(creationTime);
      creationTimeLabel.appendChild(document.createTextNode('Creation time'));
      container.appendChild(creationTimeLabel);

      var editionTime = document.createElement('input');
      editionTime.setAttribute('type', 'radio');
      editionTime.setAttribute('name', 'date-type');
      editionTime.onchange = function() {
        options.editionTime = true;
      };
      var editionTimeLabel = document.createElement('label');
      editionTimeLabel.appendChild(editionTime);
      editionTimeLabel.appendChild(document.createTextNode('Edition time'));
      container.appendChild(editionTimeLabel);
    },
    'strahler': function(container, options) {
      var smaller = document.createElement('input');
      smaller.setAttribute('type', 'radio');
      smaller.setAttribute('name', 'date-op');
      smaller.onchange = function() {
        options.op = 'smaller';
      };
      var smallerLabel = document.createElement('label');
      smallerLabel.appendChild(smaller);
      smallerLabel.appendChild(document.createTextNode('Smaller'));
      container.appendChild(smallerLabel);

      var same = document.createElement('input');
      same.setAttribute('type', 'radio');
      same.setAttribute('name', 'date-op');
      same.onchange = function() {
        options.op = 'same';
      };
      var sameLabel = document.createElement('label');
      sameLabel.appendChild(same);
      sameLabel.appendChild(document.createTextNode('Same as'));
      container.appendChild(sameLabel);

      var greater = document.createElement('input');
      greater.setAttribute('type', 'radio');
      greater.setAttribute('name', 'date-op');
      greater.setAttribute('checked', 'checked');
      greater.onchange = function() {
        options.op = 'greater';
      };
      var greaterLabel = document.createElement('label');
      greaterLabel.appendChild(greater);
      greaterLabel.appendChild(document.createTextNode('Greater'));
      container.appendChild(greaterLabel);

      var $tag = CATMAID.DOM.createNumericInputSetting("Strahler", "2", 1,
          "The reference strahler number", function() {
            options.strahlerValue = parseInt(this.value, 10);
          });
      $(container).append($tag);
    },
    'sampler-interval': function(container, options) {
      var intervalId = document.createElement('input');
      intervalId.setAttribute('type', 'number');
      intervalId.onchange = function() {
        options.intervalId = parseInt(this.value);
      };
      var intervalIdLabel = document.createElement('label');
      intervalIdLabel.appendChild(document.createTextNode('Interval ID'));
      intervalIdLabel.appendChild(intervalId);
      container.appendChild(intervalIdLabel);
    }
  };

  // A default no-op filter rule that takes all nodes.
  var defaultFilterRuleSet = [
    new CATMAID.SkeletonFilterRule(CATMAID.NodeFilterStrategy['take-all'])
  ];

  var unitIcoSpherePoints = (function() {
    var t = (1.0 + Math.sqrt(5.0)) / 2.0;

    return [
      [-1,  t,  0],
      [ 1,  t,  0],
      [-1, -t,  0],
      [ 1, -t,  0],

      [ 0, -1,  t],
      [ 0,  1,  t],
      [ 0, -1, -t],
      [ 0,  1, -t],

      [ t,  0, -1],
      [ t,  0,  1],
      [-t,  0, -1],
      [-t,  0,  1]
    ];
  })();

  var copyPoint = function(p) {
    return [p[0], p[1], p[2]];
  };

  var addToPoint = function(x, y, z, p) {
    p[0] = p[0] + x;
    p[1] = p[1] + y;
    p[2] = p[2] + z;
    return p;
  };

  var multiplyComponents = function(m, p) {
    p[0] = p[0] * m;
    p[1] = p[1] * m;
    p[2] = p[2] * m;
    return p;
  };

  // create 12 vertices of a icosahedron
  CATMAID.getIcoSpherePoints = function(x, y, z, radius) {
    return unitIcoSpherePoints
      .map(copyPoint)
      .map(multiplyComponents.bind(null, radius))
      .map(addToPoint.bind(null, x, y, z));
  };

})(CATMAID);
