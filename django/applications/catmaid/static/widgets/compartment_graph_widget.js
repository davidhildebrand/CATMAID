/* -*- mode: espresso; espresso-indent-level: 2; indent-tabs-mode: nil -*- */
/* vim: set softtabstop=2 shiftwidth=2 tabstop=2 expandtab: */

var cy;

var CompartmentGraphWidget = new function()
{

  var self = this;

  this.init = function()
  {

      $("#edgecount_threshold").bind("keyup paste", function(){
          setTimeout(jQuery.proxy(function() {
              this.val(this.val().replace(/[^0-9]/g, ''));
          }, $(this)), 0);
      });

      // id of Cytoscape Web container div
      var div_id = "#cyelement";

      var options = {
        ready: function(){
          // console.log('cytoscape ready')
        },
        style: cytoscape.stylesheet()
          .selector("node")
              .css({
                "content": "data(label)",
                "shape": "data(shape)",
                "border-width": 1,
                "background-color": "data(color)", //#DDD",
                "border-color": "#555",
                "width": "mapData(node_count, 10, 2000, 10, 50)", //"data(node_count)",
                "height": "mapData(node_count, 10, 2000, 10, 50)"   // "data(node_count)"
              })
            .selector("edge")
              .css({
                "content": "data(label)",
                "width": "data(weight)", //mapData(weight, 0, 100, 10, 50)",
                "target-arrow-shape": "data(arrow)",
                // "source-arrow-shape": "circle",
                "line-color": "data(color)",
                "opacity": 0.4,
                
              })
            .selector(":selected")
              .css({
                "background-color": "#000",
                "line-color": "#000",
                "source-arrow-color": "#000",
                "target-arrow-color": "#000",
                "text-opacity": 1.0
              })
            .selector(".ui-cytoscape-edgehandles-source")
              .css({
                "border-color": "#5CC2ED",
                "border-width": 3
              })
            .selector(".ui-cytoscape-edgehandles-target, node.ui-cytoscape-edgehandles-preview")
              .css({
                "background-color": "#444", //"#5CC2ED"
              })
            .selector("edge.ui-cytoscape-edgehandles-preview")
              .css({
                "line-color": "#5CC2ED"
              })
            .selector("node.ui-cytoscape-edgehandles-preview, node.intermediate")
              .css({
                "shape": "rectangle",
                "width": 15,
                "height": 15
              }),
      /* elements: {
          nodes: [
            { data: { id: 'foo' } }, // NB no group specified
            { data: { id: 'bar' } },
            {
                  data: { weight: 100 }, // elided id => autogenerated id 
                  position: {
                    x: 100,
                    y: 200
                  },
                  classes: 'className1 className2',
                  selected: true,
                  selectable: true,
                  locked: false,
                  grabbable: true
            },

          ],

          edges: [
            { data: { id: 'baz', source: 'foo', target: 'bar' } },
          ]
        }*/

      };
      $(div_id).cytoscape(options);
      cy = $(div_id).cytoscape("get");

  };

  this.updateGraph = function( data ) {

    for(var i = 0; i < data.nodes.length; i++) {
      data.nodes[i]['data']['color'] = NeuronStagingArea.get_color_of_skeleton( parseInt(data.nodes[i]['data'].id) );
    }

    // first remove all nodes
    cy.elements("node").remove();

    cy.add( data );

    // force arbor, does not work
    var options = {
      name: 'arbor',
      liveUpdate: true, // whether to show the layout as it's running
      ready: undefined, // callback on layoutready 
      stop: undefined, // callback on layoutstop
      maxSimulationTime: 4000, // max length in ms to run the layout
      fit: true, // fit to viewport
      padding: [ 50, 50, 50, 50 ], // top, right, bottom, left
      ungrabifyWhileSimulating: true, // so you can't drag nodes during layout

      // forces used by arbor (use arbor default on undefined)
      repulsion: undefined,
      stiffness: undefined,
      friction: undefined,
      gravity: true,
      fps: undefined,
      precision: undefined,

      // static numbers or functions that dynamically return what these
      // values should be for each element
      nodeMass: undefined, 
      edgeLength: undefined,

      stepSize: 1, // size of timestep in simulation

      // function that returns true if the system is stable to indicate
      // that the layout can be stopped
      stableEnergy: function( energy ){
          var e = energy; 
          return (e.max <= 0.5) || (e.mean <= 0.3);
      },
      stop: function() {
        console.log('layout stop');
      },
    };

    // grid
    var options = {
      name: 'grid',
      fit: true, // whether to fit the viewport to the graph
      rows: undefined, // force num of rows in the grid
      columns: undefined, // force num of cols in the grid
      ready: undefined, // callback on layoutready
      stop: undefined // callback on layoutstop
      };

    cy.layout( options );

    // cy.nodes().bind("mouseover", function(e) {
    //   // console.log('node mouseover', e);
    // });

  }

  this.updateConfidenceGraphFrom3DViewer = function() {
    requestQueue.replace(django_url + project.id + "/skeletongroup/skeletonlist_confidence_compartment_subgraph",
        "POST",
        { skeleton_list: NeuronStagingArea.get_selected_skeletons(),
          confidence_threshold: $('#confidence_threshold').val(),
          bandwidth: $('#clustering_bandwidth').val() },
        function (status, text) {
            if (200 !== status) return;
            var json = $.parseJSON(text);
            if (json.error) {
                alert(json.error);
                return;
            }
            self.updateGraph( json );
        },
        "graph_widget_request");
  }
};
